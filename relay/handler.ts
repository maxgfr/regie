/**
 * The relay's HTTP contract, host-agnostic: routing, key check, CORS and error replies. The Bun server and
 * the browser extension each inject what only they can do (which sources they open, health, segments).
 * Portable: no Node or Bun API.
 *
 *   GET /health                      → the host's health body (JSON)
 *   GET /play.m3u8?src=<page URL>    → the master playlist, variants pointing at /v/
 *   GET /v/<stream>/<variant>.m3u8   → a media playlist, ads cut, `X-Regie-Ad: 0|1`
 *   GET /s/<stream>/<segment>        → the host's segment reply (404 when the host serves none)
 */
import type { Origin, Relay } from './stream.ts'
import { UpstreamError } from './twitch.ts'

/** Version of this HTTP contract, reported by `/health`. */
export const RELAY_API_VERSION = 1

const HLS = 'application/vnd.apple.mpegurl'

export interface Replies {
  reply(request: Request, status: number, body: BodyInit | null, headers?: Record<string, string>): Response
  error(request: Request, status: number, message: string): Response
}

export interface RelayHandlerDeps {
  relay: Relay
  /**
   * A `src` the host plays: its cache key (the canonical page) and how to open it. Null refuses it (400).
   * `open` throws `UpstreamError` (404 offline, 502 failure).
   */
  source(src: string): { key: string; open: () => Promise<Origin> } | null
  /** The `/health` body; `ok: true` is the client's sign that this is a relay. */
  health(): Promise<Record<string, unknown>> | Record<string, unknown>
  /** Serves `/s/<stream>/<segment>`; without it every segment is 404 (direct segments mode). */
  segment?(request: Request, streamId: string, segmentId: string, replies: Replies): Promise<Response>
  /** Pages allowed by CORS. */
  origins?: ReadonlySet<string>
  /** When set, every request needs `?key=`. */
  key?: string
}

/** Constant-time string comparison, portable (no `node:crypto`). */
function sameKey(given: string | null, expected: string): boolean {
  if (given === null) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return diff === 0
}

export function createRelayHandler(deps: RelayHandlerDeps) {
  const { relay } = deps
  const origins = deps.origins ?? new Set<string>()

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('Origin')
    return {
      ...(origin && origins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Expose-Headers': 'X-Regie-Ad, Content-Length, Content-Range',
      Vary: 'Origin',
    }
  }

  const reply: Replies['reply'] = (request, status, body, headers = {}) =>
    new Response(body, { status, headers: { ...cors(request), 'Cache-Control': 'no-store', ...headers } })

  const error: Replies['error'] = (request, status, message) =>
    reply(request, status, JSON.stringify({ ok: false, error: message }), { 'Content-Type': 'application/json' })

  const replies: Replies = { reply, error }

  async function health(request: Request): Promise<Response> {
    const body = await deps.health()
    return reply(request, 200, JSON.stringify(body), { 'Content-Type': 'application/json' })
  }

  async function play(request: Request, url: URL, suffix: string): Promise<Response> {
    const source = deps.source(url.searchParams.get('src') ?? '')
    if (!source) return error(request, 400, 'Unsupported source')
    try {
      const stream = await relay.open(source.key, source.open)
      return reply(request, 200, stream.master(suffix), { 'Content-Type': HLS })
    } catch (failure) {
      const status = failure instanceof UpstreamError ? failure.status : 502
      return error(request, status, failure instanceof Error ? failure.message : 'Upstream failure')
    }
  }

  async function media(request: Request, streamId: string, variantId: string, suffix: string): Promise<Response> {
    const result = await relay.media(streamId, variantId, suffix)
    if (result.status !== 200)
      return error(request, result.status, result.status === 404 ? 'Offline' : 'Upstream failure')
    return reply(request, 200, result.body, { 'Content-Type': HLS, 'X-Regie-Ad': result.ad ? '1' : '0' })
  }

  async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return reply(request, 204, null, {
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return error(request, 405, 'Method not allowed')
    const url = new URL(request.url)
    const given = url.searchParams.get('key')
    if (deps.key && !sameKey(given, deps.key)) return error(request, 401, 'Bad key')
    // Every rewritten URI carries the key, since hls.js only follows URIs.
    const suffix = deps.key ? `?key=${encodeURIComponent(deps.key)}` : ''
    const path = url.pathname
    if (path === '/health') return health(request)
    if (path === '/play.m3u8') return play(request, url, suffix)
    const variant = /^\/v\/([a-z0-9]+)\/([a-z0-9]+)\.m3u8$/.exec(path)
    if (variant?.[1] && variant[2]) return media(request, variant[1], variant[2], suffix)
    const chunk = /^\/s\/([a-z0-9]+)\/([a-z0-9]+\.[a-z0-9]{1,6})$/.exec(path)
    if (chunk?.[1] && chunk[2]) {
      if (!deps.segment) return error(request, 404, 'Unknown segment')
      return deps.segment(request, chunk[1], chunk[2], replies)
    }
    return error(request, 404, 'Not found')
  }

  return {
    relay,
    replies,
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handle(request)
      } catch {
        return error(request, 502, 'Relay error')
      }
    },
  }
}

export type RelayHandler = ReturnType<typeof createRelayHandler>
