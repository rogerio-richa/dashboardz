import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: { outDir: '../static/admin', emptyOutDir: true },
  server: { proxy: { '/admin/api': 'http://localhost:8484', '/api': 'http://localhost:8484', '/sounds': 'http://localhost:8484' } },
  /*
   * `server.deps.external` is TEST-ONLY (it sits under `test`) and exists for exactly one module.
   *
   * `WidgetPreview.test.tsx`'s channel-parity guard drives the device's own `paintWidgets`
   * (`static/device/widgets/index.mjs`) so it can compare the ctx a design really receives on a
   * board with the one the preview hands it. `index.mjs` pulls in `assets.mjs`, whose
   * `new URL(\`./${widget}/assets/${file}\`, import.meta.url)` makes Vite glob the sprite sheets —
   * and those live outside this project's root, so the transform refuses them ("Denied ID
   * .../clock/assets/nixie-glyphs.png?url"). That refusal is the very reason `catalogue.mjs` was
   * split out of `index.mjs` in the first place; see its docstring.
   *
   * Externalising just `assets.mjs` hands that one file to Node's own ESM loader (it is plain
   * `.mjs`, so nothing needs transforming) and leaves every other device module on Vite's normal
   * pipeline, so no other admin test changes how it loads. Nothing here touches `vite build`: the
   * app bundle still cannot import `index.mjs`, and no source file tries to.
   */
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    server: { deps: { external: [/device\/widgets\/assets\.mjs$/] } },
  },
} as any)
