/**
 * Runs in twitch.tv's own page (main world, at document_start): Twitch's player plays from a worker (Amazon
 * IVS), which fetches the playlists. When the page starts that worker, it gets `twitch-worker.ts` first,
 * then the player's own script, so the player only ever sees ad-free playlists. Any other worker, and any
 * failure here, is left exactly as Twitch made it.
 */

/** The bundled `twitch-worker.ts`, inlined by `scripts/build-extension.ts`. */
declare const __REGIE_WORKER__: string

/** The player's worker: a blob that imports Amazon IVS's wasm worker, or that script itself. */
const PLAYER_WORKER = /amazon-ivs-wasmworker/

/** A blob or same-origin script, read now: Twitch may revoke its blob URL as soon as the worker exists. */
function read(href: string): string | null {
  try {
    const request = new XMLHttpRequest()
    request.open('GET', href, false)
    request.send()
    return request.status === 200 || (request.status === 0 && href.startsWith('blob:')) ? request.responseText : null
  } catch {
    return null
  }
}

/** The worker to start instead, or null to start Twitch's own. */
function patched(url: string | URL, options?: WorkerOptions): string | null {
  if (options?.type === 'module') return null
  const href = new URL(String(url), location.href).href
  let body: string | null
  if (PLAYER_WORKER.test(href)) body = `importScripts(${JSON.stringify(href)})`
  else if (href.startsWith('blob:')) body = read(href)
  else return null
  if (!body || !PLAYER_WORKER.test(body)) return null
  return URL.createObjectURL(new Blob([__REGIE_WORKER__, '\n;\n', body], { type: 'text/javascript' }))
}

const Native = window.Worker

class PlayerWorker extends Native {
  constructor(url: string | URL, options?: WorkerOptions) {
    let replaced: string | null = null
    try {
      replaced = patched(url, options)
    } catch {
      replaced = null
    }
    super(replaced ?? url, options)
  }
}

try {
  Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: PlayerWorker })
} catch {
  // Not replaceable here: Twitch plays as usual.
}
