/**
 * Twitch's own player, on twitch.tv, without ads: the relay engine applied to the playlists the player fetches
 * itself (the extension runs this inside the player's worker). The player keeps its master playlist and its
 * segments, fetched straight from Twitch; only its media playlists are rewritten: a playlist in an ad break
 * is replaced by an ad-free backup stream of the same quality, or has its ad segments cut
 * (`TwitchLiveVariant`), on a timeline that keeps the player's sequence numbers continuous.
 * Portable: no Node, Bun or DOM API.
 */
import {
  createTimeline,
  ingest,
  type MasterEntry,
  parseMaster,
  parseMedia,
  serializeMedia,
  type Timeline,
  timelineMedia,
} from './playlist.ts'
import { type Twitch, TwitchLiveVariant } from './twitch.ts'

/** Seconds of stream kept in a rewritten playlist: about Twitch's own live window. */
export const SITE_WINDOW_S = 30
/** Variant playlists remembered at once: the player asks usher again on a new stream or a reconnect. */
const MAX_VARIANTS = 48

const USHER_LIVE = /^https:\/\/usher\.ttvnw\.net\/api\/(?:v2\/)?channel\/hls\/([a-z0-9_]+)\.m3u8(?:\?|$)/i
const PREFETCH = '#EXT-X-TWITCH-PREFETCH:'

/** The channel of a usher live master URL, else null (VODs and everything else pass through). */
export function usherLogin(url: string): string | null {
  return USHER_LIVE.exec(url)?.[1]?.toLowerCase() ?? null
}

/** Strips the query: the player asks for a variant with the exact URL its master gave, but be lenient. */
function bare(url: string): string {
  const query = url.indexOf('?')
  return query < 0 ? url : url.slice(0, query)
}

interface Known {
  variant: TwitchLiveVariant
  timeline: Timeline
}

export interface SiteAnswer {
  status: number
  body: string
}

export class TwitchSite {
  readonly #variants = new Map<string, Known>()

  constructor(
    readonly twitch: Twitch,
    readonly windowS = SITE_WINDOW_S,
  ) {}

  /** The player loaded a live master from usher: its variants are the playlists to keep ad-free. */
  master(url: string, text: string): void {
    const login = usherLogin(url)
    if (!login) return
    let entries: MasterEntry[]
    try {
      entries = parseMaster(text, url).entries
    } catch {
      return
    }
    // Backups are asked for in the codecs the player asked for (twitch.tv's may take HEVC or AV1).
    let codecs: string | undefined
    try {
      codecs = new URL(url).searchParams.get('supported_codecs') ?? undefined
    } catch {
      codecs = undefined
    }
    for (const entry of entries) {
      if (entry.kind !== 'variant') continue
      this.#variants.delete(bare(entry.url))
      this.#variants.set(bare(entry.url), {
        variant: new TwitchLiveVariant(this.twitch, login, entry, codecs),
        timeline: createTimeline(),
      })
    }
    // Oldest first: forget the variants of masters the player left long ago.
    for (const key of this.#variants.keys()) {
      if (this.#variants.size <= MAX_VARIANTS) break
      this.#variants.delete(key)
    }
  }

  /** Whether `url` is a variant playlist of a master seen here. */
  knows(url: string): boolean {
    return this.#variants.has(bare(url))
  }

  /**
   * The player asks for a variant playlist: the ad-free one. Null when it isn't one of ours, or when nothing
   * ad-free can be served yet: the caller then lets the player fetch it as usual (an ad beats a stalled player).
   */
  async media(url: string): Promise<SiteAnswer | null> {
    const known = this.#variants.get(bare(url))
    if (!known) return null
    const loaded = await known.variant.load()
    if (!loaded.ok) return { status: loaded.status, body: '' }
    const media = parseMedia(loaded.text, loaded.url, { twitch: true })
    ingest(known.timeline, media, { windowS: this.windowS, switched: loaded.switched })
    if (!known.timeline.entries.length) return null
    let body = serializeMedia(timelineMedia(known.timeline), (segment) => segment)
    // Low latency: the segments Twitch announces ahead come right after the last one, on the stream served,
    // so they take the next sequence numbers here too. Only on a playlist without an ad.
    if (!media.ad) {
      const prefetch = loaded.text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(PREFETCH))
      if (prefetch.length) body += `${prefetch.join('\n')}\n`
    }
    return { status: 200, body }
  }
}
