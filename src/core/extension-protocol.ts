/**
 * Messages between Regie's page and the "Regie relay" browser extension. The extension's content script
 * (the bridge) talks to the page with `window.postMessage`, and to its service worker, which runs the relay
 * in the browser, with `chrome.runtime.sendMessage`. Pure: types, constants and guards only.
 *
 *   page → bridge   { source: 'regie-page', type: 'ping' }
 *                   { source: 'regie-page', type: 'request', id, url }   url: '/play.m3u8?src=…', '/v/…', '/health'
 *   bridge → page   { source: 'regie-extension', type: 'hello', version }   on load and on every ping
 *                   { source: 'regie-extension', type: 'response', id, status, headers, body }   status 0: failed
 *   bridge → worker { type: 'regie-relay', url }  →  { status, headers, body }
 */

export const PAGE_SOURCE = 'regie-page'
export const EXTENSION_SOURCE = 'regie-extension'
/** `chrome.runtime` message type, bridge → service worker. */
export const RELAY_MESSAGE = 'regie-relay'
/** The base the worker resolves request paths against; it never leaves the extension. */
export const EXTENSION_BASE = 'https://regie-extension.invalid'
/** Pages the extension serves: Regie on GitHub Pages, the dev server and the preview. */
export const EXTENSION_ORIGINS: readonly string[] = [
  'https://maxgfr.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
]

/** Longest request path accepted: a `/play.m3u8?src=` with an encoded page URL fits well under it. */
const MAX_URL = 2048

export interface PagePing {
  source: typeof PAGE_SOURCE
  type: 'ping'
}

export interface PageRequest {
  source: typeof PAGE_SOURCE
  type: 'request'
  /** Chosen by the page; the response carries it back. */
  id: string
  /** A relay path with its query, e.g. `/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud`. */
  url: string
}

export type PageMessage = PagePing | PageRequest

export interface ExtensionHello {
  source: typeof EXTENSION_SOURCE
  type: 'hello'
  /** The extension's manifest version. */
  version: string
}

export interface RelayReply {
  /** HTTP status; 0 when the extension could not answer (worker gone, extension reloaded). */
  status: number
  headers: Record<string, string>
  body: string
}

export interface ExtensionResponse extends RelayReply {
  source: typeof EXTENSION_SOURCE
  type: 'response'
  id: string
}

export type ExtensionMessage = ExtensionHello | ExtensionResponse

/** Bridge → service worker. */
export interface RelayRequest {
  type: typeof RELAY_MESSAGE
  url: string
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A relay path: starts with one `/` (never `//host`), bounded length. */
export function isRelayPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_URL && value.startsWith('/') && !value.startsWith('//')
}

export function isPageMessage(data: unknown): data is PageMessage {
  if (!record(data) || data.source !== PAGE_SOURCE) return false
  if (data.type === 'ping') return true
  return data.type === 'request' && typeof data.id === 'string' && data.id.length <= 64 && isRelayPath(data.url)
}

export function isExtensionMessage(data: unknown): data is ExtensionMessage {
  if (!record(data) || data.source !== EXTENSION_SOURCE) return false
  if (data.type === 'hello') return typeof data.version === 'string'
  return (
    data.type === 'response' &&
    typeof data.id === 'string' &&
    typeof data.status === 'number' &&
    record(data.headers) &&
    typeof data.body === 'string'
  )
}

export function isRelayRequest(data: unknown): data is RelayRequest {
  return record(data) && data.type === RELAY_MESSAGE && isRelayPath(data.url)
}

export function isRelayReply(data: unknown): data is RelayReply {
  return record(data) && typeof data.status === 'number' && record(data.headers) && typeof data.body === 'string'
}

/** The reply the bridge sends when the worker did not answer. */
export function failedReply(): RelayReply {
  return { status: 0, headers: {}, body: '' }
}
