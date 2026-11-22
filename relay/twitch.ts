/**
 * Twitch without the embed: anonymous playback token, usher master, and ad replacement.
 *
 * Twitch decides ads when it issues the token and the usher playlist, from the requester's IP and player
 * type. Like TTV LOL PRO and the vaft script, on a `stitched-ad` playlist we ask for fresh tokens with other
 * player types (and the optional proxy toggled), serve the first ad-free stream during the break, and fall
 * back to stripping the ad segments only when every attempt has ads.
 */
import { isAdPlaylist, type Master, type MasterEntry, matchEntry, parseMaster } from './playlist.ts'
import type { Loaded, Origin, Upstream } from './stream.ts'

export const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const GQL = 'https://gql.twitch.tv/gql'
const QUERY =
  'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}'

export interface Access {
  playerType: string
  platform: string
  /** Send the token, usher and playlist requests through `TWITCH_PROXY`. */
  proxy: boolean
}

/** vaft's forced player type for the main stream (`TWITCH_PLAYER_TYPE` overrides it). */
export const PRIMARY = { playerType: 'popout', platform: 'web' }
/** Player types accepted for the main stream. */
export const PLAYER_TYPES = ['site', 'popout', 'embed', 'mobile_web', 'autoplay']
/** Probed in order on an ad break; the last winner of a channel goes first. */
export const BACKUP_TYPES = ['site', 'popout', 'mobile_web', 'embed']
/** Low quality but usually ad-free: the last try before stripping. */
export const LAST_RESORT = { playerType: 'autoplay', platform: 'android' }
/** A player type that had ads is not probed again for this long. */
export const FAILED_TTL_MS = 15_000

type FetchLike = (url: string, init?: RequestInit & { proxy?: string }) => Promise<Response>

export interface TwitchOptions {
  proxy?: string
  fetch?: FetchLike
  now?: () => number
  timeoutMs?: number
  log?: (message: string) => void
  /** Player type of the main stream; `autoplay` goes with the android platform. */
  playerType?: string
}

export class UpstreamError extends Error {
  constructor(
    readonly status: 404 | 502,
    message: string,
  ) {
    super(message)
  }
}

type Target = { login: string } | { vod: string }

function randomId(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join('')
}

export class Twitch {
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #proxy?: string
  readonly #timeoutMs: number
  readonly log: (message: string) => void
  readonly #primary: { playerType: string; platform: string }
  /** Winning backup player type per channel. */
  readonly pins = new Map<string, string>()
  /** `channel/playerType` → when it last had ads. */
  readonly #failed = new Map<string, number>()

  constructor(options: TwitchOptions = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#now = options.now ?? Date.now
    this.#proxy = options.proxy || undefined
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.log = options.log ?? (() => {})
    const playerType = options.playerType ?? PRIMARY.playerType
    this.#primary = playerType === LAST_RESORT.playerType ? LAST_RESORT : { playerType, platform: 'web' }
  }

  get primaryAccess(): Access {
    return { ...this.#primary, proxy: Boolean(this.#proxy) }
  }

  /** Backups go the other way from the primary: direct if the primary uses the proxy, and back. */
  #backupAccess(type: { playerType: string; platform: string }): Access {
    return { ...type, proxy: this.#proxy ? !this.primaryAccess.proxy : false }
  }

  async #request(url: string, init: RequestInit, proxy: boolean): Promise<Response> {
    const signal = AbortSignal.timeout(this.#timeoutMs)
    return this.#fetch(url, proxy && this.#proxy ? { ...init, signal, proxy: this.#proxy } : { ...init, signal })
  }

  /** Anonymous playback token: public web client id, random device id, no Authorization. */
  async token(target: Target, access: Access): Promise<{ value: string; signature: string }> {
    const isVod = 'vod' in target
    const body = {
      operationName: 'PlaybackAccessToken_Template',
      query: QUERY,
      variables: {
        isLive: !isVod,
        isVod,
        login: isVod ? '' : target.login,
        platform: access.platform,
        playerType: access.playerType,
        vodID: isVod ? target.vod : '',
      },
    }
    const headers = {
      'Client-ID': TWITCH_CLIENT_ID,
      'Device-ID': randomId(32),
      'Content-Type': 'text/plain;charset=UTF-8',
    }
    const response = await this.#request(GQL, { method: 'POST', headers, body: JSON.stringify(body) }, access.proxy)
    if (!response.ok) throw new UpstreamError(502, `Twitch GQL ${response.status}`)
    type Token = { value?: string; signature?: string; authorization?: { isForbidden?: boolean } } | null
    const json = (await response.json()) as {
      data?: { streamPlaybackAccessToken?: Token; videoPlaybackAccessToken?: Token }
    }
    const token = isVod ? json.data?.videoPlaybackAccessToken : json.data?.streamPlaybackAccessToken
    if (!json.data) throw new UpstreamError(502, 'Twitch GQL returned no data')
    if (!token?.value || !token.signature) throw new UpstreamError(404, 'No such Twitch channel or video')
    if (token.authorization?.isForbidden) throw new UpstreamError(502, 'Twitch refused playback (geo or sub only)')
    return { value: token.value, signature: token.signature }
  }

  /** `codecs`: the `supported_codecs` usher may answer with (the relay's hls.js plays H.264 only). */
  usherUrl(target: Target, token: { value: string; signature: string }, codecs = 'avc1'): string {
    const url = new URL(
      'vod' in target
        ? `https://usher.ttvnw.net/vod/${target.vod}.m3u8`
        : `https://usher.ttvnw.net/api/channel/hls/${target.login}.m3u8`,
    )
    const params = {
      sig: token.signature,
      token: token.value,
      allow_source: 'true',
      allow_audio_only: 'true',
      fast_bread: 'true',
      player_backend: 'mediaplayer',
      playlist_include_framerate: 'true',
      supported_codecs: codecs,
      p: String(Math.floor(Math.random() * 10_000_000)),
      play_session_id: randomId(32),
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.href
  }

  /** Token + usher: the master playlist. 404 when offline. */
  async master(target: Target, access: Access, codecs?: string): Promise<{ url: string; master: Master }> {
    const token = await this.token(target, access)
    const url = this.usherUrl(target, token, codecs)
    const response = await this.#request(url, {}, access.proxy)
    if (response.status === 404) throw new UpstreamError(404, 'Offline')
    if (!response.ok) throw new UpstreamError(502, `Twitch usher ${response.status}`)
    return { url, master: parseMaster(await response.text(), url) }
  }

  /** A video-weaver (or VOD) media playlist. */
  async playlist(url: string, proxy: boolean): Promise<{ status: number; text: string }> {
    const response = await this.#request(url, {}, proxy)
    return { status: response.status, text: response.ok ? await response.text() : '' }
  }

  #isFailed(login: string, playerType: string): boolean {
    const at = this.#failed.get(`${login}/${playerType}`)
    return at !== undefined && this.#now() - at < FAILED_TTL_MS
  }

  #fail(login: string, playerType: string): void {
    this.#failed.set(`${login}/${playerType}`, this.#now())
  }

  /**
   * Looks for an ad-free stream of the same variant: the backup player types in order (the channel's last
   * winner first), then the android autoplay stream. Types that had ads in the last 15 s are skipped.
   * `codecs` is asked of usher as the player asked it; a backup is always in the codec `wanted` is in.
   */
  async findBackup(login: string, wanted: MasterEntry, codecs?: string): Promise<Backup | null> {
    const pinned = this.pins.get(login)
    const order = [...new Set([...(pinned ? [pinned] : []), ...BACKUP_TYPES])]
    for (const playerType of order) {
      if (this.#isFailed(login, playerType)) continue
      const backup = await this.#probe(login, wanted, this.#backupAccess({ playerType, platform: 'web' }), codecs)
      if (backup) {
        this.pins.set(login, playerType)
        return backup
      }
      this.#fail(login, playerType)
    }
    if (!this.#isFailed(login, LAST_RESORT.playerType)) {
      const backup = await this.#probe(login, wanted, this.#backupAccess(LAST_RESORT), codecs)
      if (backup) return backup
      this.#fail(login, LAST_RESORT.playerType)
    }
    return null
  }

  async #probe(login: string, wanted: MasterEntry, access: Access, codecs?: string): Promise<Backup | null> {
    let result: string
    let backup: Backup | null = null
    try {
      const { master } = await this.master({ login }, access, codecs)
      // A player's decoder is set up for one codec: an H.264 backup for an HEVC variant breaks it.
      const family = codecFamily(wanted.attrs.CODECS)
      const entry = matchEntry(
        family ? master.entries.filter((candidate) => codecFamily(candidate.attrs.CODECS) === family) : master.entries,
        wanted,
      )
      if (!entry) result = 'no matching variant'
      else {
        const { status, text } = await this.playlist(entry.url, access.proxy)
        if (status !== 200) result = `playlist ${status}`
        else if (isAdPlaylist(text)) result = 'ad'
        else {
          result = `clean (${entry.name})`
          backup = { url: entry.url, access, text }
        }
      }
    } catch (error) {
      result = `error: ${error instanceof Error ? error.message : 'failed'}`
    }
    this.log(`twitch ${login} ${wanted.name}: probe ${accessLabel(access)} → ${result}`)
    return backup
  }

  /** Marks a backup that started showing ads. */
  failBackup(login: string, backup: Backup): void {
    this.#fail(login, backup.access.playerType)
  }

  async live(login: string): Promise<Origin> {
    const access = this.primaryAccess
    const { master } = await this.master({ login }, access)
    return { master, upstream: (entry) => new TwitchLiveVariant(this, login, entry), vod: false }
  }

  async vod(id: string): Promise<Origin> {
    const access = this.primaryAccess
    const { master } = await this.master({ vod: id }, access)
    const upstream = (entry: MasterEntry): Upstream => ({
      load: async () => {
        const { status, text } = await this.playlist(entry.url, access.proxy)
        if (status === 404 || status === 403) return { ok: false, status: 404 }
        return status === 200 ? { ok: true, text, url: entry.url } : { ok: false, status: 502 }
      },
    })
    return { master, upstream, vod: true }
  }
}

/**
 * The video codec of a variant's `CODECS`: `avc`, `hevc`, `av1`, `audio` (no picture), or '' when it doesn't
 * say (then any variant matches).
 */
export function codecFamily(codecs: string | undefined): string {
  if (!codecs) return ''
  const list = codecs.split(',').map((codec) => codec.trim().toLowerCase())
  for (const codec of list) {
    if (codec.startsWith('avc')) return 'avc'
    if (codec.startsWith('hev') || codec.startsWith('hvc')) return 'hevc'
    if (codec.startsWith('av01')) return 'av1'
  }
  return list.some((codec) => codec.startsWith('mp4a')) ? 'audio' : ''
}

function accessLabel(access: Access): string {
  return `${access.playerType}/${access.platform}${access.proxy ? '+proxy' : ''}`
}

export interface Backup {
  url: string
  access: Access
  text: string
}

/** One variant of a live channel: the primary weaver playlist, swapped for a backup during ad breaks. */
export class TwitchLiveVariant implements Upstream {
  #url: string
  #backup: Backup | null = null
  #onBackup = false
  #stripping = false
  #inBreak = false

  /** `codecs`: the `supported_codecs` the player asked usher for (twitch.tv's own player), else H.264 only. */
  constructor(
    readonly twitch: Twitch,
    readonly login: string,
    readonly entry: MasterEntry,
    readonly codecs?: string,
  ) {
    this.#url = entry.url
  }

  get onBackup(): boolean {
    return this.#onBackup
  }

  async #primary(): Promise<{ text: string; url: string } | Loaded> {
    const access = this.twitch.primaryAccess
    let { status, text } = await this.twitch.playlist(this.#url, access.proxy)
    if (status === 403 || status === 404) {
      // Expired token or new weaver session: ask usher again (404 there means offline).
      const { master } = await this.twitch.master({ login: this.login }, access, this.codecs)
      const entry = matchEntry(master.entries, this.entry)
      if (!entry) return { ok: false, status: 502 }
      this.#url = entry.url
      ;({ status, text } = await this.twitch.playlist(this.#url, access.proxy))
    }
    if (status !== 200) return { ok: false, status: status === 404 ? 404 : 502 }
    return { text, url: this.#url }
  }

  async load(): Promise<Loaded> {
    let primary: { text: string; url: string } | Loaded
    try {
      primary = await this.#primary()
    } catch (error) {
      return { ok: false, status: error instanceof UpstreamError ? error.status : 502 }
    }
    if ('ok' in primary) return primary
    if (!isAdPlaylist(primary.text)) {
      if (this.#inBreak) this.#log(this.#onBackup ? 'primary clean, back to primary' : 'primary clean, ad over')
      this.#inBreak = false
      this.#stripping = false
      return this.#serve(false, primary.text, primary.url)
    }
    if (!this.#inBreak) this.#log(`ad on primary (${accessLabel(this.twitch.primaryAccess)})`)
    this.#inBreak = true
    if (this.#backup) {
      const current = await this.twitch.playlist(this.#backup.url, this.#backup.access.proxy).catch(() => null)
      if (current?.status === 200 && !isAdPlaylist(current.text))
        return this.#serve(true, current.text, this.#backup.url)
      this.#log(`backup ${accessLabel(this.#backup.access)} got ads`)
      this.twitch.failBackup(this.login, this.#backup)
      this.#backup = null
    }
    const backup = await this.twitch.findBackup(this.login, this.entry, this.codecs)
    if (backup) {
      this.#backup = backup
      this.#stripping = false
      this.#log(`serving backup ${accessLabel(backup.access)}`)
      return this.#serve(true, backup.text, backup.url, true)
    }
    // Every stream has ads: serve the primary and let the timeline strip them.
    if (!this.#stripping) this.#log('every stream has ads, cutting ad segments')
    this.#stripping = true
    return this.#serve(false, primary.text, primary.url)
  }

  #log(message: string): void {
    this.twitch.log(`twitch ${this.login} ${this.entry.name}: ${message}`)
  }

  #serve(onBackup: boolean, text: string, url: string, fresh = false): Loaded {
    const switched = fresh || onBackup !== this.#onBackup
    this.#onBackup = onBackup
    if (!onBackup) this.#backup = null
    return { ok: true, text, url, switched, twitch: true }
  }
}
