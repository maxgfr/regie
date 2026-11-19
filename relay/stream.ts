/**
 * Streams and their variant pollers. A stream is one canonical source with its rewritten master; each
 * variant a player asks for gets a poller that keeps a rolling, ad-free window with its own sequence.
 * Segments are only reachable through the opaque ids handed out here.
 */
import {
  createTimeline,
  ingest,
  type Master,
  type MasterEntry,
  type Media,
  parseMedia,
  serializeMaster,
  serializeMedia,
  type Timeline,
  timelineMedia,
} from './playlist.ts'

export type Loaded =
  | {
      ok: true
      text: string
      /** Base URL to resolve the playlist's relative URIs against. */
      url: string
      /** The upstream changed (Twitch backup stream): start a discontinuity. */
      switched?: boolean
      /** Flag and strip Twitch stitched-ad segments. */
      twitch?: boolean
    }
  | { ok: false; status: 404 | 502 }

export interface Upstream {
  load(): Promise<Loaded>
}

export interface Origin {
  master: Master
  upstream(entry: MasterEntry): Upstream
  /** VOD-like sources: kept much longer when idle, since a paused player stops asking. */
  vod: boolean
  close?(): void
}

const IDLE_LIVE_MS = 60_000
const IDLE_VOD_MS = 30 * 60_000
const RETIRED_MS = 60_000
const FIRST_LOAD_MS = 20_000

function opaqueId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}

/** Keeps the upstream extension on segment ids: picky demuxers (ffmpeg, VLC) refuse segments without one. */
function extension(url: string): string {
  try {
    return (
      /\.(ts|m4s|mp4|m4a|m4v|aac|vtt|webvtt|key|cmfv|cmfa|mp3)$/i.exec(new URL(url).pathname)?.[0].toLowerCase() ??
      '.ts'
    )
  } catch {
    return '.ts'
  }
}

class Variant {
  readonly id = opaqueId()
  mode: 'unknown' | 'live' | 'whole' = 'unknown'
  timeline: Timeline = createTimeline()
  whole?: Media
  ad = false
  failure: 404 | 502 | null = null
  lastRequest = Date.now()
  #upstream?: Upstream
  #timer?: ReturnType<typeof setTimeout>
  #first?: Promise<void>
  #stopped = true
  /** Bumped on every start and stop, so a load still in flight from an old run is dropped. */
  #run = 0

  constructor(
    readonly stream: Stream,
    readonly entry: MasterEntry,
  ) {}

  /** Starts polling on first request; resolves once the first upstream load is in. */
  ready(): Promise<void> {
    this.lastRequest = Date.now()
    if (this.#stopped) {
      this.#stopped = false
      this.#upstream = this.stream.origin.upstream(this.entry)
      this.#first = this.#poll(++this.#run)
    }
    return this.#first ?? Promise.resolve()
  }

  stop(): void {
    this.#stopped = true
    this.#run++
    clearTimeout(this.#timer)
    this.timeline = createTimeline()
    this.whole = undefined
    this.mode = 'unknown'
    this.failure = null
  }

  async #poll(run: number): Promise<void> {
    const upstream = this.#upstream
    if (!upstream || run !== this.#run) return
    let delay = 2000
    try {
      const loaded = await upstream.load()
      if (run !== this.#run) return
      if (!loaded.ok) {
        // 404 after a re-resolve means the live is over: end what we have.
        if (loaded.status === 404 && this.timeline.entries.length) this.timeline.ended = true
        else this.failure = loaded.status
        if (loaded.status === 404) return
        delay = 5000
      } else {
        this.failure = null
        delay = this.#apply(loaded)
      }
    } catch {
      this.failure = this.failure ?? 502
      delay = 5000
    }
    if (delay > 0 && run === this.#run) this.#timer = setTimeout(() => void this.#poll(run), delay)
  }

  /** Folds a load into the variant; returns the next poll delay (0 = done). */
  #apply(loaded: Extract<Loaded, { ok: true }>): number {
    const media = parseMedia(loaded.text, loaded.url, { twitch: loaded.twitch })
    if (this.mode === 'unknown') this.mode = media.endList || media.playlistType ? 'whole' : 'live'
    const tail = media.segments.at(-1)
    const every = Math.min(Math.max(tail?.duration || media.targetDuration || 2, 1), 10) * 1000
    if (this.mode === 'whole') {
      this.whole = media
      for (const segment of media.segments) this.stream.register(segment, this.id)
      return media.endList ? 0 : every
    }
    ingest(this.timeline, media, { windowS: this.stream.windowS, switched: loaded.switched })
    this.ad = Boolean(loaded.twitch && tail?.ad)
    this.stream.retire(this.id, this.timeline)
    return this.timeline.ended ? 0 : every
  }

  playlist(suffix: string): string {
    const uri = (url: string) => `/s/${this.stream.id}/${this.stream.idFor(url, this.id)}${suffix}`
    if (this.mode === 'whole' && this.whole) return serializeMedia(this.whole, uri)
    return serializeMedia(timelineMedia(this.timeline), uri)
  }
}

class Stream {
  readonly id = opaqueId()
  readonly variants = new Map<string, Variant>()
  readonly #byEntry = new Map<MasterEntry, Variant>()
  /** Segment id → upstream URL, and back. */
  readonly #segments = new Map<string, { url: string; owner: string; retiredAt?: number }>()
  readonly #ids = new Map<string, string>()
  lastRequest = Date.now()

  constructor(
    readonly key: string,
    readonly origin: Origin,
    readonly windowS: number,
  ) {
    for (const entry of origin.master.entries) {
      const variant = new Variant(this, entry)
      this.variants.set(variant.id, variant)
      this.#byEntry.set(entry, variant)
    }
  }

  master(suffix: string): string {
    return serializeMaster(this.origin.master, (entry) => `/v/${this.id}/${this.#byEntry.get(entry)?.id}.m3u8${suffix}`)
  }

  idFor(url: string, owner: string): string {
    let id = this.#ids.get(url)
    if (!id) {
      id = opaqueId() + extension(url)
      this.#ids.set(url, id)
      this.#segments.set(id, { url, owner })
    }
    const record = this.#segments.get(id)
    if (record) record.retiredAt = undefined
    return id
  }

  register(segment: { url: string; map?: { url: string }; key?: { URI?: string } }, owner: string): void {
    this.idFor(segment.url, owner)
    if (segment.map) this.idFor(segment.map.url, owner)
    if (segment.key?.URI) this.idFor(segment.key.URI, owner)
  }

  /** Marks the segments of `owner` that left its window; they are dropped a minute later. */
  retire(owner: string, timeline: Timeline): void {
    const live = new Set<string>()
    for (const entry of timeline.entries) {
      live.add(entry.url)
      if (entry.map) live.add(entry.map.url)
      if (entry.key?.URI) live.add(entry.key.URI)
    }
    const now = Date.now()
    for (const [id, record] of this.#segments) {
      if (record.owner !== owner) continue
      if (live.has(record.url)) record.retiredAt = undefined
      else if (record.retiredAt === undefined) record.retiredAt = now
      else if (now - record.retiredAt > RETIRED_MS) {
        this.#segments.delete(id)
        this.#ids.delete(record.url)
      }
    }
  }

  segment(id: string): string | undefined {
    this.lastRequest = Date.now()
    return this.#segments.get(id)?.url
  }

  sweep(now: number): void {
    for (const variant of this.variants.values()) {
      if (now - variant.lastRequest > IDLE_LIVE_MS && !this.origin.vod) variant.stop()
    }
  }

  close(): void {
    for (const variant of this.variants.values()) variant.stop()
    this.#segments.clear()
    this.#ids.clear()
    try {
      this.origin.close?.()
    } catch {}
  }
}

export type { Stream, Variant }

export type MediaResult = { status: 200; body: string; ad: boolean } | { status: 404 | 502 }

export class Relay {
  readonly #streams = new Map<string, Stream>()
  readonly #byKey = new Map<string, Stream>()
  readonly #opening = new Map<string, Promise<Stream>>()
  readonly #sweeper: ReturnType<typeof setInterval>

  constructor(readonly windowS: number) {
    this.#sweeper = setInterval(() => this.sweep(Date.now()), 10_000)
    this.#sweeper.unref?.()
  }

  /** The stream of a canonical source, opening it once (concurrent callers share the same open). */
  async open(key: string, open: () => Promise<Origin>): Promise<Stream> {
    const existing = this.#byKey.get(key)
    if (existing) {
      existing.lastRequest = Date.now()
      return existing
    }
    let pending = this.#opening.get(key)
    if (!pending) {
      pending = open().then((origin) => {
        const stream = new Stream(key, origin, this.windowS)
        this.#streams.set(stream.id, stream)
        this.#byKey.set(key, stream)
        return stream
      })
      this.#opening.set(key, pending)
      pending.then(
        () => this.#opening.delete(key),
        () => this.#opening.delete(key),
      )
    }
    return pending
  }

  async media(streamId: string, variantId: string, suffix: string): Promise<MediaResult> {
    const stream = this.#streams.get(streamId)
    const variant = stream?.variants.get(variantId)
    if (!stream || !variant) return { status: 404 }
    stream.lastRequest = Date.now()
    const ready = variant.ready()
    await Promise.race([ready, Bun.sleep(FIRST_LOAD_MS)])
    const empty =
      variant.mode === 'unknown' || (variant.mode === 'live' && !variant.timeline.entries.length && !variant.ad)
    if (variant.failure && empty) {
      const status = variant.failure
      variant.stop()
      return { status }
    }
    if (variant.mode === 'unknown') return { status: 502 }
    return { status: 200, body: variant.playlist(suffix), ad: variant.ad }
  }

  segment(streamId: string, segmentId: string): string | undefined {
    return this.#streams.get(streamId)?.segment(segmentId)
  }

  sweep(now: number): void {
    for (const stream of this.#streams.values()) {
      stream.sweep(now)
      if (now - stream.lastRequest > (stream.origin.vod ? IDLE_VOD_MS : IDLE_LIVE_MS)) this.#drop(stream)
    }
  }

  #drop(stream: Stream): void {
    stream.close()
    this.#streams.delete(stream.id)
    if (this.#byKey.get(stream.key) === stream) this.#byKey.delete(stream.key)
  }

  /** Forgets a source (e.g. after its upstream died) so the next /play opens it fresh. */
  forget(key: string): void {
    const stream = this.#byKey.get(key)
    if (stream) this.#drop(stream)
  }

  close(): void {
    clearInterval(this.#sweeper)
    for (const stream of this.#streams.values()) this.#drop(stream)
  }

  get size(): number {
    return this.#streams.size
  }
}
