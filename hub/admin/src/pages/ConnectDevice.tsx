import { DOCS_URL } from '../docs'
import { displayAddress, portOf, type HubAddress } from '../hubAddress'

/** One line above the device list: where devices on the network reach this hub. */
export function HubAddressLine({ address }: { address: HubAddress }) {
  if (!address.url) {
    return (
      <p className="hub-address-line">
        <span className="warn-text">Devices can't use the address this page is open at (localhost).</span>{' '}
        Add a device to see how to find this computer's network address.
      </p>
    )
  }
  return (
    <p className="hub-address-line">
      Devices on your network reach this hub at <code className="hub-address">{displayAddress(address.url)}</code>
      {address.others.length > 0 && <> (or {address.others.map(displayAddress).join(', ')})</>}
    </p>
  )
}

function FindYourAddress() {
  return (
    <div className="connect-warning">
      <p>
        <strong className="warn-text">This page is open at localhost, which only this computer can use.</strong>{' '}
        Devices need this computer's address on your network, such as <code>192.168.1.20</code>. To find it:
      </p>
      <ul>
        <li><strong>Mac:</strong> System Settings, Wi-Fi, Details next to your network: the IP address.</li>
        <li><strong>Windows:</strong> run <code>ipconfig</code> and look for IPv4 Address.</li>
        <li><strong>Linux:</strong> run <code>hostname -I</code>; the first address is usually the one.</li>
      </ul>
      <p>
        Then set <code>PUBLIC_URL=http://that-address:8484</code> in the hub's <code>.env</code> and run{' '}
        <code>docker compose up -d hub</code>, so the QR code carries it. Until then, open this admin
        at that address instead of localhost, or type the address on the device by hand.{' '}
        <a href={DOCS_URL + 'getting-started/#find-your-computers-address'} target="_blank" rel="noreferrer">More on finding it</a>.
      </p>
    </div>
  )
}

function CantReach({ address }: { address: HubAddress }) {
  const shown = address.url ? displayAddress(address.url) : 'the hub address'
  return (
    <details className="connect-help">
      <summary>Device can't reach the hub?</summary>
      <ul>
        <li>
          Connect the device to the <strong>same Wi-Fi network</strong> as this computer. Guest networks
          usually keep devices apart, so avoid them.
        </li>
        <li>Type the address exactly as shown, including the <code>:{portOf(address.url)}</code> port.</li>
        <li>
          Test it: open <code>{shown}</code> in the device's browser. If the Dashboardz page doesn't
          load, the problem is the network, not the code.
        </li>
        <li>
          Let this computer's firewall accept connections on port {portOf(address.url)} (on a Mac:
          System Settings, Network, Firewall).
        </li>
        <li>Turn off any VPN on the device or on this computer.</li>
        <li>
          If the address changes after a restart, give this computer a fixed address (a DHCP
          reservation) in your router.
        </li>
      </ul>
      <p>
        More help: <a href={DOCS_URL + 'getting-started/#if-a-device-cant-reach-the-hub'} target="_blank" rel="noreferrer">if a device can't reach the hub</a>.
      </p>
    </details>
  )
}

/** Shown after "Add device": everything someone needs at the device, in the order they need it. */
export function ConnectDevice({ name, code, qr, address, onDone }: {
  name: string
  code: string
  qr: string | null
  address: HubAddress
  onDone: () => void
}) {
  const shown = address.url ? displayAddress(address.url) : null
  return (
    <div className="connect-panel">
      <h3>Connect {name ? `“${name}”` : 'the new device'}</h3>
      {!shown && <FindYourAddress />}
      <div className="connect-body">
        {qr && <img src={qr} alt={`Pairing QR ${code}`} width={180} height={180} />}
        <div className="connect-steps">
          <dl className="connect-values">
            <dt>Hub address</dt>
            <dd><code className="hub-address">{shown ?? 'this computer’s network address'}</code></dd>
            <dt>Pairing code</dt>
            <dd><code className="pair-code">{code}</code> <span className="hint-inline">valid for 10 minutes</span></dd>
          </dl>
          <ol>
            <li>
              <strong>Android app:</strong> {qr ? 'tap Scan QR and point the camera at this code, or type' : 'type'} the hub
              address and the pairing code.
            </li>
            <li>
              <strong>Any browser:</strong> open <code>{shown ? `${shown}/device` : 'that address followed by /device'}</code> on
              the device and type the code.
            </li>
          </ol>
          {address.source === 'browser' && (
            <p className="hint-inline">
              This is the address you opened the admin at. Set <code>PUBLIC_URL</code> in the hub's <code>.env</code> to
              it so the starter screen and links use it too.
            </p>
          )}
          {address.source === 'lan' && (
            <p className="hint-inline">
              Found on this computer's network adapters. Set <code>PUBLIC_URL</code> in the hub's environment so the
              hub always uses the right one.
            </p>
          )}
        </div>
      </div>
      <CantReach address={address} />
      <button onClick={onDone}>Done</button>
    </div>
  )
}
