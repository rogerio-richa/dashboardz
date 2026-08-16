package com.dashboardz.device.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.dashboardz.device.BuildConfig
import com.dashboardz.device.core.BoardError
import com.dashboardz.device.core.BoardReloadGate
import com.dashboardz.device.core.isFatalBoardError
import com.dashboardz.device.service.DeviceController
import com.dashboardz.device.service.Link
import org.json.JSONObject

/**
 * The board, rendered by the shipped web renderer inside a WebView (web-renderer boundary).
 *
 * THE SHELL OWNS THE SOCKET; THIS PAGE NEVER DIALS OUT. `registry.ts` closes the existing socket
 * whenever a second arrives for the same device id — `close(4000, 'replaced')` — so a page opening
 * its own connection would ping-pong with the shell's forever. A real storm was measured at 40
 * connect/disconnect pairs a minute, each socket alive 16–20ms. device.js checks for
 * `__dashboardzHost` and stays offline when it finds one; installing the interface BEFORE the load
 * is therefore load-bearing, not incidental.
 *
 * The takeover is NOT here (native takeover boundary). A critical alert covers this view with the native Compose
 * screen, so a wedged, blank or still-loading WebView can never mute the 3am wake path.
 */
class BoardBridge(
    private val controller: DeviceController,
    private val onReady: () -> Unit,
    private val deviceToken: () -> String?,
) {
    /**
     * The device token, for the board's own authenticated GETs — the theme document and image
     * feeds. The page holds none of its own (the shell paired on its behalf), so without this
     * every such fetch sent `Bearer null` and 401'd: a themed board rendered with built-in
     * defaults and an image widget stayed blank, both silently, because both degrade quietly.
     *
     * This is NOT a way for the page to open its own socket: sendFromBoard still refuses HELLO,
     * and the page only dials out at all when no host is installed.
     */
    @JavascriptInterface
    fun token(): String = deviceToken() ?: ""

    /**
     * Page -> hub. Validated against the protocol by DeviceController.sendFromBoard rather than
     * forwarded as text: a page is a less trusted surface than native code.
     *
     * Runs on a WebView-owned binder thread, never the main thread — everything it touches must
     * tolerate that. The transport already does; anything Compose-facing must be posted.
     */
    @JavascriptInterface
    fun send(json: String) {
        controller.sendFromBoard(json)
    }

    /** The page reporting that its module has evaluated and it can accept frames. */
    @JavascriptInterface
    fun ready() {
        onReady()
    }

    /**
     * The shell explicitly claiming the takeover/alarm surface (native takeover boundary, hardened). Without this the
     * native `TakeoverScreen` and the page's own `#takeover` could both be on screen for the same
     * critical, each sounding its own alarm (page WebAudio + native ToneGenerator double-beeping)
     * — a user saw the web takeover when the native one should have owned the device.
     *
     * Always true: this shell's TakeoverScreen (options, wake, ToneGenerator) is the reliability
     * surface, and it owns the device whenever it is hosting the page at all. The page only acts
     * on this after checking `typeof host.ownsTakeover === 'function'` (device.js's
     * `hostOwnsTakeover`), so an OLDER shell build — which has no such method — still falls back
     * to the page's own web takeover exactly as it does today; this method's existence must never
     * take that fallback away from a shell that predates it.
     */
    @JavascriptInterface
    fun ownsTakeover(): Boolean = true
}

@Composable
fun BoardWebView(
    hubUrl: String,
    controller: DeviceController,
    /** Read lazily: a re-pair replaces the token while the same page is still loaded. */
    deviceToken: () -> String?,
    /**
     * Fatal board failures, for the native failure surface. null means the board recovered.
     *
     * Before this existed the error was swallowed into the reload gate and the panel simply went
     * black, which is what made the 2026-08-27 outage undiagnosable from the wall.
     */
    onBoardError: (BoardError?) -> Unit,
    /** Incremented by the failure card's Retry button to force an immediate reload. */
    retryTrigger: Int,
    modifier: Modifier = Modifier,
) {
    val main = remember0 { Handler(Looper.getMainLooper()) }
    val webView = remember0 { java.util.concurrent.atomic.AtomicReference<WebView?>(null) }
    val reloadGate = remember0 { BoardReloadGate() }
    val link by controller.state.collectAsStateWithLifecycle()

    DisposableEffect(controller) {
        onDispose { controller.boardSink = null }
    }

    /**
     * Tell the page whether the hub is reachable. It owns no socket, so its own readyState says
     * nothing — without this it showed OFFLINE permanently, over a board that was in fact live.
     *
     * The same transition is the page's retry signal: the shell reconnects its socket by itself,
     * but a board load that failed while offline remains black after socket recovery unless the
     * page is reloaded. If the board's own load failed, ONLINE means the network is back; reload it.
     */
    LaunchedEffect(link.link) {
        val online = link.link == Link.ONLINE
        webView.get()?.let { view ->
            if (reloadGate.reloadNeeded(online)) view.reload()
            view.evaluateJavascript("__dashboardzLink($online)", null)
        }
    }

    /**
     * The link-independent retry pump. The gate decides WHETHER to reload; this only supplies the
     * clock. Without it a panel whose hub address is wrong never reloads at all, because its
     * socket never reaches ONLINE and the ONLINE-transition trigger above can never fire. See
     * BoardReloadGate.retryDue.
     */
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(1_000)
            if (reloadGate.retryDue(android.os.SystemClock.elapsedRealtime())) {
                webView.get()?.reload()
            }
        }
    }

    /** The failure card's Retry button: reload at once, skipping the backoff. */
    LaunchedEffect(retryTrigger) {
        if (retryTrigger > 0) webView.get()?.reload()
    }

    AndroidView(
        modifier = modifier,
        factory = { context ->
            // Debug builds only. Without it there is no way to get a real number out of the board:
            // `dumpsys gfxinfo` reports the HOST app's UI thread, and a WebView composites on its
            // own render thread — so it measures Compose being idle, not the page being fast.
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
            @SuppressLint("SetJavaScriptEnabled")
            WebView(context).apply {
                // MATCH_PARENT explicitly. AndroidView gives a child WRAP_CONTENT by default,
                // which for a WebView is circular: its height depends on the page's content, and
                // the page is `height: 100vh`, which depends on the viewport height. The board
                // measured 853x0 and painted nothing but its background colour.
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                // Off by default in a WebView, and without it `localStorage` is null rather than
                // empty. The page is null-safe about that now, but the board legitimately wants
                // storage for its own caches.
                settings.domStorageEnabled = true
                // The board is a fixed-size surface, not a document: no zoom, no overscroll, no
                // text autosizing. Autosizing in particular would silently re-scale exactly the
                // type the fit model just negotiated.
                settings.textZoom = 100
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = WebView.OVER_SCROLL_NEVER
                setBackgroundColor(android.graphics.Color.BLACK)

                // Feeds the reload gate (see the LaunchedEffect above): a failed main frame or a
                // failed /device asset marks the board dead; the next ONLINE transition reloads it.
                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        reloadGate.onLoadStarted()
                        // A load that is underway means the previous failure no longer stands, so
                        // a recovered board dismisses the failure card without a separate signal.
                        onBoardError(null)
                    }

                    override fun onReceivedError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        error: WebResourceError?,
                    ) {
                        val mainFrame = request?.isForMainFrame == true
                        val path = request?.url?.path
                        reloadGate.onLoadError(mainFrame = mainFrame, urlPath = path)
                        // Only a fatal failure raises the card. An image feed dying must never
                        // cover a board that is rendering fine.
                        if (isFatalBoardError(mainFrame, path)) {
                            onBoardError(
                                BoardError(
                                    mainFrame = mainFrame,
                                    urlPath = path,
                                    code = error?.errorCode ?: 0,
                                    description = error?.description?.toString(),
                                ),
                            )
                        }
                    }
                }

                val bridge = BoardBridge(controller, deviceToken = deviceToken, onReady = {
                    // replayToBoard touches the sink, and the sink posts to the main thread; the
                    // call itself arrives on a binder thread.
                    main.post {
                        controller.replayToBoard()
                        // Report link state as soon as the page can accept it, so a board that
                        // loads while already connected never flashes OFFLINE.
                        val online = controller.state.value.link == Link.ONLINE
                        webView.get()?.evaluateJavascript("__dashboardzLink($online)", null)
                    }
                })
                // BEFORE loadUrl: device.js reads __dashboardzHost at module scope to decide
                // whether it owns a socket. Installed late, the page would connect on its own.
                addJavascriptInterface(bridge, "__dashboardzHost")

                controller.boardSink = { frame ->
                    // evaluateJavascript is main-thread only; frames arrive on the socket thread.
                    // JSONObject.quote does the escaping, so a message containing quotes or
                    // newlines cannot break out of the call it is embedded in.
                    main.post {
                        evaluateJavascript("__dashboardzDeliver(${JSONObject.quote(frame)})", null)
                    }
                }

                webView.set(this)
                loadUrl("${hubUrl.trimEnd('/')}/device")
            }
        },
    )
}

/** Local `remember` alias so this file needs no extra import juggling for one handler. */
@Composable
private inline fun <T> remember0(crossinline init: () -> T): T =
    androidx.compose.runtime.remember { init() }
