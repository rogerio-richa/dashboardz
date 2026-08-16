import { BRAND } from './brand.js'

/**
 * The hub answers on two paths a human might want — /admin and /device — and nothing at all on
 * the root, which is where anyone typing the hub's address by hand lands first. Fastify's default
 * there is a raw JSON 404, so the first thing a new operator sees is an error about a route they
 * never asked for.
 *
 * Self-contained on purpose: no stylesheet, no font, no image. A hub commonly runs on a LAN with
 * no route to the internet, and a landing page that renders unstyled in exactly that case would
 * fail the audience it exists for.
 */
export function landingPage(opts: { notFound?: boolean } = {}): string {
  const notice = opts.notFound ? '<p class="notice">No page here — try one of these.</p>' : ''
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND.name}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #f6f4ef; color: #2b2b2b; }
  main { text-align: center; padding: 2rem; max-width: 28rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .sub { margin: 0 0 1.5rem; opacity: .7; }
  .notice { margin: 0 0 1.5rem; }
  nav { display: flex; gap: .75rem; justify-content: center; flex-wrap: wrap; }
  nav a { display: block; padding: .6rem 1.1rem; border: 1px solid currentColor;
          border-radius: .4rem; text-decoration: none; color: inherit; }
  footer { margin-top: 2rem; font-size: .9rem; opacity: .7; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181a; color: #e8e6e1; }
  }
</style>
<main>
  <h1>${BRAND.name}</h1>
  <p class="sub">This is a ${BRAND.name} hub.</p>
  ${notice}
  <nav>
    <a href="/admin">Admin</a>
    <a href="/device">Device view</a>
  </nav>
  <footer><a href="${BRAND.url}">What is ${BRAND.name}?</a></footer>
</main>
`
}
