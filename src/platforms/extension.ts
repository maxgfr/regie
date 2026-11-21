import {
  EXTENSION_BASE,
  failedReply,
  isExtensionMessage,
  isRelayPath,
  PAGE_SOURCE,
  type PageMessage,
  type RelayReply,
} from '../core/extension-protocol.ts'
import { parseHealth, type RelayHealth } from '../core/relay.ts'

/**
 * The page's side of the "Regie relay" browser extension: its bridge (a content script) answers relay
 * requests with `window.postMessage`. Optional like the server relay: without the extension every call
 * resolves to "not there" (`null`, status 0) and the embeds play. Nothing here throws.
 */

/** How long to wait for the bridge's hello. It runs at `document_start`, so a ping is answered at once. */
export const EXTENSION_HELLO_MS = 300
/** How long the extension's `/health` may take (the service worker may have to wake up). */
const HEALTH_MS = 3000

/** The window the bridge shares with the page (an `EventTarget` stands in for it in the tests). */
export interface BridgeWindow {
  postMessage(message: unknown, targetOrigin: string): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  location: { origin: string }
}

export interface ExtensionClient {
  /** The extension's version once it said hello, else null. */
  readonly version: string | null
  /** Resolves with the extension's version, or null if it doesn't say hello within `timeoutMs`. */
  present(timeoutMs?: number): Promise<string | null>
  /** A relay path (`/health`, `/play.m3u8?src=…`, `/v/…`) through the extension. Status 0: no answer. */
  fetch(path: string, options?: { timeoutMs?: number }): Promise<RelayReply>
  /** The extension's `/health`, or null when it isn't there or doesn't answer. */
  health(): Promise<RelayHealth | null>
  /** Called on every hello: the extension may have been installed or enabled since the page loaded. */
  onHello(listener: (version: string) => void): void
}

export function createExtensionClient(win: BridgeWindow): ExtensionClient {
  let version: string | null = null
  let counter = 0
  const prefix = Math.random().toString(36).slice(2, 10)
  const pending = new Map<string, (reply: RelayReply) => void>()
  const waiters = new Set<(version: string) => void>()
  const listeners: ((version: string) => void)[] = []

  const post = (message: PageMessage): boolean => {
    try {
      win.postMessage(message, win.location.origin)
      return true
    } catch {
      // An opaque origin (file://) can't be targeted: no extension there.
      return false
    }
  }

  win.addEventListener('message', (event) => {
    // Only this window's own scripts (the bridge), never a frame's.
    if ((event.source && event.source !== win) || event.origin !== win.location.origin) return
    const data: unknown = event.data
    if (!isExtensionMessage(data)) return
    if (data.type === 'hello') {
      version = data.version.slice(0, 40)
      for (const waiter of [...waiters]) waiter(version)
      for (const listener of listeners) {
        try {
          listener(version)
        } catch {
          // A listener's failure is its own.
        }
      }
      return
    }
    const { status, headers, body } = data
    pending.get(data.id)?.({ status, headers, body })
  })

  const present = (timeoutMs = EXTENSION_HELLO_MS): Promise<string | null> => {
    if (version) return Promise.resolve(version)
    return new Promise((resolve) => {
      const done = (value: string | null) => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      waiters.add(done)
      if (!post({ source: PAGE_SOURCE, type: 'ping' })) done(null)
    })
  }

  const fetch = (path: string, options: { timeoutMs?: number } = {}): Promise<RelayReply> => {
    if (!isRelayPath(path)) return Promise.resolve(failedReply())
    const id = `${prefix}-${++counter}`
    return new Promise((resolve) => {
      const done = (reply: RelayReply) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(reply)
      }
      const timer = setTimeout(() => done(failedReply()), options.timeoutMs ?? 20_000)
      pending.set(id, done)
      if (!post({ source: PAGE_SOURCE, type: 'request', id, url: path })) done(failedReply())
    })
  }

  return {
    get version() {
      return version
    },
    present,
    fetch,
    async health() {
      if (!(await present())) return null
      const reply = await fetch('/health', { timeoutMs: HEALTH_MS })
      if (reply.status !== 200) return null
      try {
        return parseHealth(JSON.parse(reply.body))
      } catch {
        return null
      }
    },
    onHello(listener) {
      listeners.push(listener)
    },
  }
}

let client: ExtensionClient | null = null

/** The page's extension client, created on first use (it starts listening for the bridge then). */
export function extension(): ExtensionClient | null {
  if (client) return client
  if (typeof window === 'undefined') return null
  client = createExtensionClient(window)
  return client
}

/** The extension's `/health`, or null: no extension, or one that no longer answers (reloaded, disabled). */
export function extensionHealth(): Promise<RelayHealth | null> {
  return extension()?.health() ?? Promise.resolve(null)
}

/** The relay path of an address hls.js resolved against the extension's base, or null for any other one. */
export function extensionPath(url: string): string | null {
  if (!url.startsWith(`${EXTENSION_BASE}/`)) return null
  const path = url.slice(EXTENSION_BASE.length)
  return isRelayPath(path) ? path : null
}

/** A reply's header, whatever its case (the worker lowercases them; a server may not). */
export function replyHeader(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return null
}
