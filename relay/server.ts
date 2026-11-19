/**
 * Regie's optional HLS relay: `bun relay/server.ts`.
 * Serves ad-free HLS for Twitch, YouTube and Kick to the static page, through opaque ids only.
 */
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { canonicalize, isRemuxFile, openOrigin, stopRemuxes, toolVersion } from './resolve.ts'
import { Relay } from './stream.ts'
import { PLAYER_TYPES, PRIMARY, Twitch, UpstreamError } from './twitch.ts'

export interface Config {
  port: number
  host: string
  origins: Set<string>
  key?: string
  twitchProxy?: string
  /** Player type of Twitch's main stream (`TWITCH_PLAYER_TYPE`). */
  twitchPlayerType: string
  windowS: number
}

/** `TWITCH_PLAYER_TYPE`, checked: an unknown type warns and falls back to the default. */
export function twitchPlayerType(value: string | undefined, warn: (message: string) => void = console.warn): string {
  const type = value?.trim()
  if (!type) return PRIMARY.playerType
  if (PLAYER_TYPES.includes(type)) return type
  warn(`relay: TWITCH_PLAYER_TYPE "${type}" is not one of ${PLAYER_TYPES.join(', ')}; using ${PRIMARY.playerType}`)
  return PRIMARY.playerType
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT) || 7878,
    host: env.HOST || '127.0.0.1',
    origins: new Set(
      (env.ORIGINS ?? 'https://maxgfr.github.io,http://localhost:5173,http://localhost:4173')
        .split(',')
        .map((origin) => origin.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),
    key: env.RELAY_KEY || undefined,
    twitchProxy: env.TWITCH_PROXY || undefined,
    twitchPlayerType: twitchPlayerType(env.TWITCH_PLAYER_TYPE),
    windowS: Number(env.WINDOW_S) || 180,
  }
}

const HLS = 'application/vnd.apple.mpegurl'

/** Segment URLs come from the platforms' playlists; still, never let one point the relay at a private address. */
export function publicHttp(target: string): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[')) return false
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (!ip) return true
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return !(
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}
const VERSION = 1

function sameKey(given: string | null, expected: string): boolean {
  if (given === null) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createHandler(config: Config) {
  const relay = new Relay(config.windowS)
  const twitch = new Twitch({
    proxy: config.twitchProxy,
    playerType: config.twitchPlayerType,
    log: (message) => console.log(message),
  })
  let tools: { at: number; ytdlp: string | null; ffmpeg: string | null } | undefined

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('Origin')
    return {
      ...(origin && config.origins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Expose-Headers': 'X-Regie-Ad, Content-Length, Content-Range',
      Vary: 'Origin',
    }
  }

  const reply = (request: Request, status: number, body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...cors(request), 'Cache-Control': 'no-store', ...headers } })

  const error = (request: Request, status: number, message: string) =>
    reply(request, status, JSON.stringify({ ok: false, error: message }), { 'Content-Type': 'application/json' })

  async function health(request: Request): Promise<Response> {
    if (!tools || Date.now() - tools.at > 60_000) {
      const [ytdlp, ffmpeg] = await Promise.all([toolVersion('yt-dlp'), toolVersion('ffmpeg')])
      tools = { at: Date.now(), ytdlp, ffmpeg }
    }
    const body = { ok: true, version: VERSION, ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg }
    return reply(request, 200, JSON.stringify(body), { 'Content-Type': 'application/json' })
  }

  async function play(request: Request, url: URL, suffix: string): Promise<Response> {
    const source = canonicalize(url.searchParams.get('src') ?? '')
    if (!source) return error(request, 400, 'Unsupported source')
    try {
      const stream = await relay.open(source.page, () => openOrigin(source, twitch))
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

  async function segment(request: Request, streamId: string, segmentId: string): Promise<Response> {
    const target = relay.segment(streamId, segmentId)
    if (!target) return error(request, 404, 'Unknown segment')
    const range = request.headers.get('Range')
    if (target.startsWith('file:')) return localFile(request, fileURLToPath(target), range)
    if (!publicHttp(target)) return error(request, 404, 'Unknown segment')
    try {
      const upstream = await fetch(target, {
        headers: range ? { Range: range } : {},
        signal: request.signal,
        decompress: false,
      })
      if (upstream.status >= 400 && upstream.status !== 416) return error(request, 502, `Upstream ${upstream.status}`)
      const headers: Record<string, string> = { 'Content-Type': upstream.headers.get('Content-Type') ?? 'video/mp2t' }
      for (const name of ['Content-Length', 'Content-Range', 'Content-Encoding', 'Accept-Ranges']) {
        const value = upstream.headers.get(name)
        if (value) headers[name] = value
      }
      return reply(request, upstream.status, upstream.body, headers)
    } catch {
      return error(request, 502, 'Upstream failure')
    }
  }

  async function localFile(request: Request, path: string, range: string | null): Promise<Response> {
    if (!isRemuxFile(path)) return error(request, 404, 'Unknown segment')
    const file = Bun.file(path)
    if (!(await file.exists())) return error(request, 404, 'Unknown segment')
    const type = path.endsWith('.m4s') || path.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'
    const size = file.size
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start > end || start >= size) return reply(request, 416, null, { 'Content-Range': `bytes */${size}` })
      return reply(request, 206, file.slice(start, end + 1), {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      })
    }
    return reply(request, 200, file, { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' })
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
    if (config.key && !sameKey(given, config.key)) return error(request, 401, 'Bad key')
    // Every rewritten URI carries the key, since hls.js only follows URIs.
    const suffix = config.key ? `?key=${encodeURIComponent(config.key)}` : ''
    const path = url.pathname
    if (path === '/health') return health(request)
    if (path === '/play.m3u8') return play(request, url, suffix)
    const variant = /^\/v\/([a-z0-9]+)\/([a-z0-9]+)\.m3u8$/.exec(path)
    if (variant?.[1] && variant[2]) return media(request, variant[1], variant[2], suffix)
    const chunk = /^\/s\/([a-z0-9]+)\/([a-z0-9]+\.[a-z0-9]{1,6})$/.exec(path)
    if (chunk?.[1] && chunk[2]) return segment(request, chunk[1], chunk[2])
    return error(request, 404, 'Not found')
  }

  return {
    relay,
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handle(request)
      } catch {
        return error(request, 502, 'Relay error')
      }
    },
  }
}

if (import.meta.main) {
  const config = configFromEnv()
  const handler = createHandler(config)
  const server = Bun.serve({ port: config.port, hostname: config.host, idleTimeout: 60, fetch: handler.fetch })
  const ytdlp = await toolVersion('yt-dlp')
  const ffmpeg = await toolVersion('ffmpeg')
  console.log(`Regie relay on http://${server.hostname}:${server.port}`)
  console.log(`  origins: ${[...config.origins].join(', ')}`)
  console.log(
    `  key: ${config.key ? 'required' : 'none (local use only)'} · twitch: ${config.twitchPlayerType}, proxy ${config.twitchProxy ? 'on' : 'off'}`,
  )
  console.log(`  yt-dlp: ${ytdlp ?? 'missing (only Twitch works)'} · ffmpeg: ${ffmpeg ?? 'missing (no YouTube VODs)'}`)
  if (!config.key && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    console.warn('  warning: listening beyond localhost without RELAY_KEY: anyone who can reach it can use it')
  }
  const shutdown = () => {
    handler.relay.close()
    stopRemuxes()
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('unhandledRejection', (reason) => console.error('relay: unhandled', reason))
}
