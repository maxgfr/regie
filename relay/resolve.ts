/**
 * Source validation and resolution: which links the relay accepts, and how each becomes an HLS origin
 * (Twitch's own API, yt-dlp's HLS manifest, or an ffmpeg remux of a YouTube VOD).
 */
import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMasterPlaylist, type MasterEntry, matchEntry, parseMaster, singleVariantMaster } from './playlist.ts'
import { openTwitch, type RelaySource } from './source.ts'
import type { Loaded, Origin, Upstream } from './stream.ts'
import { type Twitch, UpstreamError } from './twitch.ts'

export { canonicalize, type RelaySource } from './source.ts'

// --- Tools ---

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** `yt-dlp --version` / ffmpeg's version, or null when missing. */
export async function toolVersion(tool: 'yt-dlp' | 'ffmpeg'): Promise<string | null> {
  try {
    const { code, stdout } = await run(tool === 'yt-dlp' ? ['yt-dlp', '--version'] : ['ffmpeg', '-version'], 10_000)
    if (code !== 0) return null
    const line = stdout.trim().split('\n')[0] ?? ''
    return tool === 'ffmpeg' ? (/^ffmpeg version (\S+)/.exec(line)?.[1] ?? line) || null : line || null
  } catch {
    return null
  }
}

const OFFLINE =
  /not currently live|is offline|will begin|has ended|not live|premieres in|is_upcoming|live event will|does not exist|video unavailable|private video/i

interface Format {
  url?: string
  manifest_url?: string
  protocol?: string
  http_headers?: Record<string, string>
  tbr?: number
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  /** YouTube answers 403 until this time (epoch seconds); yt-dlp sleeps for it too. */
  available_at?: number
}

interface Info extends Format {
  is_live?: boolean
  live_status?: string
  formats?: Format[]
  requested_formats?: Format[]
}

/** H.264 ≤ 1080p + m4a audio, else a progressive mp4, else the best there is (lives only have HLS). */
const YOUTUBE_VOD_FORMAT = 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b'

let ytdlpVersion: Promise<string | null> | undefined

/** YouTube needs a JS runtime; yt-dlp ≥ 2025.11 can use the Bun running the relay (deno stays first). */
async function runtimeArgs(): Promise<string[]> {
  ytdlpVersion ??= toolVersion('yt-dlp')
  const version = await ytdlpVersion
  return version && version >= '2025.11' && process.versions.bun ? ['--js-runtimes', `bun:${process.execPath}`] : []
}

async function ytdlp(page: string, format?: string): Promise<Info> {
  let result: Awaited<ReturnType<typeof run>>
  try {
    const options = [
      '-J',
      '--no-warnings',
      '--no-playlist',
      ...(await runtimeArgs()),
      ...(format ? ['-f', format] : []),
    ]
    const args = ['yt-dlp', ...options, '--', page]
    result = await run(args, 45_000)
  } catch {
    throw new UpstreamError(502, 'yt-dlp is not installed')
  }
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').at(-1) ?? 'yt-dlp failed'
    throw new UpstreamError(OFFLINE.test(result.stderr) ? 404 : 502, reason)
  }
  try {
    return JSON.parse(result.stdout) as Info
  } catch {
    throw new UpstreamError(502, 'yt-dlp returned no JSON')
  }
}

function hlsManifest(info: Info): string | undefined {
  if (info.manifest_url) return info.manifest_url
  const hls = (info.formats ?? []).filter((format) => format.protocol?.startsWith('m3u8'))
  return hls.find((format) => format.manifest_url)?.manifest_url ?? hls.at(-1)?.url
}

type Resolved = { type: 'hls'; manifest: string; at: number } | { type: 'files'; info: Info; at: number }

const RESOLVE_TTL_MS = 10 * 60_000
const cache = new Map<string, Resolved>()

/** yt-dlp resolution, cached per canonical page for ten minutes. */
async function resolveWithYtdlp(source: RelaySource, fresh = false): Promise<Resolved> {
  const cached = cache.get(source.page)
  if (cached && !fresh && Date.now() - cached.at < RESOLVE_TTL_MS) return cached
  const youtubeVideo = source.platform === 'youtube' && source.id.length === 11
  const info = await ytdlp(source.page, youtubeVideo ? YOUTUBE_VOD_FORMAT : undefined)
  const live = info.is_live === true || info.live_status === 'is_live'
  let resolved: Resolved
  if (youtubeVideo && !live) resolved = { type: 'files', info, at: Date.now() }
  else {
    const manifest = hlsManifest(info)
    if (!manifest) throw new UpstreamError(404, 'No HLS stream')
    resolved = { type: 'hls', manifest, at: Date.now() }
  }
  cache.set(source.page, resolved)
  return resolved
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  return { status: response.status, text: response.ok ? await response.text() : '' }
}

/** A master from an HLS URL; a bare media playlist becomes a one-variant master. */
async function loadMaster(manifest: string) {
  const { status, text } = await fetchText(manifest)
  if (status === 404 || status === 403 || status === 410) throw new UpstreamError(404, `Upstream ${status}`)
  if (status !== 200) throw new UpstreamError(502, `Upstream ${status}`)
  return isMasterPlaylist(text) ? parseMaster(text, manifest) : singleVariantMaster(manifest)
}

/** An HLS origin resolved by yt-dlp; a 403/404 on a live playlist re-resolves once. */
async function hlsOrigin(source: RelaySource, manifest: string): Promise<Origin> {
  const master = await loadMaster(manifest)
  const upstream = (entry: MasterEntry): Upstream => {
    let url = entry.url
    return {
      load: async (): Promise<Loaded> => {
        try {
          let { status, text } = await fetchText(url)
          if ((status === 403 || status === 404 || status === 410) && source.kind === 'live') {
            const fresh = await resolveWithYtdlp(source, true)
            if (fresh.type !== 'hls') return { ok: false, status: 502 }
            const next = matchEntry((await loadMaster(fresh.manifest)).entries, entry)
            if (!next) return { ok: false, status: 502 }
            url = next.url
            ;({ status, text } = await fetchText(url))
          }
          if (status === 200) return { ok: true, text, url }
          return { ok: false, status: status === 404 || status === 410 ? 404 : 502 }
        } catch (error) {
          return { ok: false, status: error instanceof UpstreamError ? error.status : 502 }
        }
      },
    }
  }
  return { master, upstream, vod: source.kind === 'vod' }
}

const remuxes = new Set<{ proc: ReturnType<typeof Bun.spawn>; dir: string }>()

/** True for a file inside one of our live remux folders: the only local files /s may serve. */
export function isRemuxFile(path: string): boolean {
  for (const { dir } of remuxes) if (path.startsWith(`${dir}/`) && !path.includes('..')) return true
  return false
}

/** Kills every ffmpeg and removes their folders (process exit). */
export function stopRemuxes(): void {
  for (const remux of remuxes) {
    remux.proc.kill()
    rmSync(remux.dir, { recursive: true, force: true })
  }
  remuxes.clear()
}

function headerArgs(format: Format): string[] {
  const headers = format.http_headers ?? {}
  const userAgent = headers['User-Agent']
  const rest = Object.entries(headers)
    .filter(([name]) => name !== 'User-Agent')
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')
  return [...(userAgent ? ['-user_agent', userAgent] : []), ...(rest ? ['-headers', rest] : [])]
}

/** A YouTube VOD remuxed (no re-encode) by ffmpeg into a growing fMP4 HLS playlist in a temp folder. */
async function remuxOrigin(info: Info): Promise<Origin> {
  const inputs = (info.requested_formats?.length ? info.requested_formats : [info]).filter((format) => format.url)
  if (!inputs.length) throw new UpstreamError(502, 'No downloadable format')
  const availableAt = Math.max(0, ...inputs.map((input) => (input.available_at ?? 0) * 1000))
  await Bun.sleep(Math.min(Math.max(0, availableAt - Date.now()), 15_000))
  const dir = await mkdtemp(join(tmpdir(), 'regie-relay-'))
  const playlist = join(dir, 'index.m3u8')
  const args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin']
  for (const input of inputs) args.push(...headerArgs(input), '-reconnect', '1', '-i', input.url as string)
  args.push(...(inputs.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0']))
  args.push(
    ...['-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4'],
    ...['-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg%05d.m4s'), playlist],
  )
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
  } catch {
    await rm(dir, { recursive: true, force: true })
    throw new UpstreamError(502, 'ffmpeg is not installed')
  }
  const remux = { proc, dir }
  remuxes.add(remux)
  const close = () => {
    proc.kill()
    remuxes.delete(remux)
    rmSync(dir, { recursive: true, force: true })
  }
  // Wait for the first segments, or ffmpeg's failure.
  // A fresh Bun.file each time: one made before the file existed keeps reading it as empty.
  const read = () =>
    Bun.file(playlist)
      .text()
      .catch(() => '')
  const deadline = Date.now() + 30_000
  while (!(await read()).includes('#EXTINF')) {
    if (proc.exitCode !== null || Date.now() > deadline) {
      close()
      throw new UpstreamError(502, 'ffmpeg remux failed')
    }
    await Bun.sleep(250)
  }
  const height = Math.max(...inputs.map((input) => input.height ?? 0))
  const width = Math.max(...inputs.map((input) => input.width ?? 0))
  const bandwidth = Math.round(inputs.reduce((sum, input) => sum + (input.tbr ?? 0), 0) * 1000) || 2_000_000
  const url = Bun.pathToFileURL(playlist).href
  const codecs = inputs.flatMap((input) => [input.vcodec, input.acodec]).filter((codec) => codec && codec !== 'none')
  const master = singleVariantMaster(url, {
    BANDWIDTH: String(bandwidth),
    ...(codecs.length ? { CODECS: codecs.join(',') } : {}),
    ...(width && height ? { RESOLUTION: `${width}x${height}` } : {}),
  })
  const upstream = (): Upstream => ({
    load: async () => {
      const text = await read()
      // ffmpeg died mid-way: end the playlist instead of letting the player wait forever.
      const ended = proc.exitCode !== null && !text.includes('#EXT-X-ENDLIST')
      return { ok: true, text: ended ? `${text}#EXT-X-ENDLIST\n` : text, url }
    },
  })
  return { master, upstream, vod: true, close }
}

/** Opens the origin of a canonical source. Throws `UpstreamError` (404 offline, 502 failure). */
export async function openOrigin(source: RelaySource, twitch: Twitch): Promise<Origin> {
  if (source.platform === 'twitch') {
    try {
      return await openTwitch(source, twitch)
    } catch (error) {
      // Offline is final; anything else (GQL changed, refused) gets yt-dlp's opinion.
      if (error instanceof UpstreamError && error.status === 404 && source.kind === 'live') throw error
    }
  }
  const resolved = await resolveWithYtdlp(source)
  return resolved.type === 'hls' ? hlsOrigin(source, resolved.manifest) : remuxOrigin(resolved.info)
}

export function forgetResolution(page: string): void {
  cache.delete(page)
}
