/**
 * Regie's optional HLS relay: `bun relay/server.ts`.
 * Serves ad-free HLS for Twitch, YouTube and Kick to the static page, through opaque ids only.
 */
import { fileURLToPath } from 'node:url'
import { createRelayHandler, RELAY_API_VERSION, type Replies } from './handler.ts'
import { canonicalize, isRemuxFile, openOrigin, stopRemuxes, toolVersion } from './resolve.ts'
import { Relay } from './stream.ts'
import { PLAYER_TYPES, PRIMARY, Twitch } from './twitch.ts'

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

export function createHandler(config: Config) {
  const relay = new Relay(config.windowS)
  const twitch = new Twitch({
    proxy: config.twitchProxy,
    playerType: config.twitchPlayerType,
    log: (message) => console.log(message),
  })
  let tools: { at: number; ytdlp: string | null; ffmpeg: string | null } | undefined

  async function health() {
    if (!tools || Date.now() - tools.at > 60_000) {
      const [ytdlp, ffmpeg] = await Promise.all([toolVersion('yt-dlp'), toolVersion('ffmpeg')])
      tools = { at: Date.now(), ytdlp, ffmpeg }
    }
    // Twitch needs Bun alone; YouTube and Kick go through yt-dlp.
    const platforms = tools.ytdlp ? ['twitch', 'youtube', 'kick'] : ['twitch']
    return { ok: true, version: RELAY_API_VERSION, ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg, platforms }
  }

  async function segment(request: Request, streamId: string, segmentId: string, { reply, error }: Replies) {
    const target = relay.segment(streamId, segmentId)
    if (!target) return error(request, 404, 'Unknown segment')
    const range = request.headers.get('Range')
    if (target.startsWith('file:')) return localFile(request, fileURLToPath(target), range, { reply, error })
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

  async function localFile(request: Request, path: string, range: string | null, { reply, error }: Replies) {
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

  return createRelayHandler({
    relay,
    origins: config.origins,
    key: config.key,
    health,
    source: (src) => {
      const source = canonicalize(src)
      return source && { key: source.page, open: () => openOrigin(source, twitch) }
    },
    segment,
  })
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
