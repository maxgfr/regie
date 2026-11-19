/**
 * Pure HLS helpers: parse and serialize master and media playlists, detect Twitch's stitched ads,
 * and keep the relay's own rolling timeline (sequence numbers, discontinuities, window).
 */

export type Attrs = Record<string, string>

/** Parses `KEY=value,KEY="quoted, value"` attribute lists. */
export function parseAttrs(text: string): Attrs {
  const attrs: Attrs = {}
  for (const match of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const [, key, value] = match
    if (key && value !== undefined) attrs[key] = value.startsWith('"') ? value.slice(1, -1) : value
  }
  return attrs
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href
  } catch {
    return uri
  }
}

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function tagValue(line: string): string {
  return line.slice(line.indexOf(':') + 1)
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF')
}

// --- Master playlists ---

export interface MasterEntry {
  /** A variant (`EXT-X-STREAM-INF` + URI) or a rendition (`EXT-X-MEDIA` with a URI, e.g. YouTube's audio). */
  kind: 'variant' | 'media'
  url: string
  attrs: Attrs
  /** A stable name to find the same variant in another master (Twitch's quality name, else the resolution). */
  name: string
}

type MasterItem = { line: string; entry?: MasterEntry }

export interface Master {
  items: MasterItem[]
  entries: MasterEntry[]
}

const MASTER_TAGS = /^#(EXTM3U|EXT-X-VERSION|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-START|EXT-X-MEDIA|EXT-X-STREAM-INF)(:|$)/

/** Parses a master playlist, resolving URIs. Keeps only the standard tags a player needs. */
export function parseMaster(text: string, base: string): Master {
  const items: MasterItem[] = []
  const videoNames = new Map<string, string>()
  let pending: Attrs | null = null
  for (const line of linesOf(text)) {
    if (!line.startsWith('#')) {
      if (!pending) continue
      const name = pending.VIDEO ?? pending.RESOLUTION ?? pending.BANDWIDTH ?? line
      items.push({ line, entry: { kind: 'variant', url: resolve(line, base), attrs: pending, name } })
      pending = null
      continue
    }
    if (!MASTER_TAGS.test(line)) continue
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttrs(tagValue(line))
      items.push({ line })
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(tagValue(line))
      if (attrs.TYPE === 'VIDEO' && attrs['GROUP-ID'] && attrs.NAME) videoNames.set(attrs['GROUP-ID'], attrs.NAME)
      const uri = attrs.URI
      const name = `${attrs.TYPE}/${attrs['GROUP-ID']}/${attrs.NAME}`
      items.push(uri ? { line, entry: { kind: 'media', url: resolve(uri, base), attrs, name } } : { line })
    } else {
      items.push({ line })
    }
  }
  const entries = items.flatMap((item) => (item.entry ? [item.entry] : []))
  for (const entry of entries) {
    const group = entry.attrs.VIDEO
    if (entry.kind === 'variant' && group) entry.name = videoNames.get(group) ?? group
  }
  return { items, entries }
}

/** A master with a single variant, for upstreams that hand out a media playlist directly. */
export function singleVariantMaster(url: string, attrs: Attrs = {}): Master {
  const entry: MasterEntry = { kind: 'variant', url, attrs: { BANDWIDTH: '2000000', ...attrs }, name: 'main' }
  const inf = Object.entries(entry.attrs)
    .map(([key, value]) => (key === 'CODECS' ? `${key}="${value}"` : `${key}=${value}`))
    .join(',')
  return { items: [{ line: '#EXTM3U' }, { line: `#EXT-X-STREAM-INF:${inf}` }, { line: url, entry }], entries: [entry] }
}

export function serializeMaster(master: Master, uriFor: (entry: MasterEntry) => string): string {
  const out = master.items.map(({ line, entry }) => {
    if (!entry) return line
    const uri = uriFor(entry)
    return entry.kind === 'variant' ? uri : line.replace(/URI="[^"]*"/, `URI="${uri}"`)
  })
  if (out[0] !== '#EXTM3U') out.unshift('#EXTM3U')
  return `${out.join('\n')}\n`
}

/** Finds the entry matching `wanted` in another master: same name, else same resolution, else nearest bandwidth. */
export function matchEntry(entries: MasterEntry[], wanted: MasterEntry): MasterEntry | undefined {
  const pool = entries.filter((entry) => entry.kind === wanted.kind)
  const res = wanted.attrs.RESOLUTION
  const fps = wanted.attrs['FRAME-RATE']
  const exact =
    pool.find((entry) => entry.name === wanted.name) ??
    pool.find((entry) => res && entry.attrs.RESOLUTION === res && entry.attrs['FRAME-RATE'] === fps) ??
    pool.find((entry) => res && entry.attrs.RESOLUTION === res)
  if (exact) return exact
  // Keep video for video: an audio-only variant has no RESOLUTION.
  const sameShape = pool.filter((entry) => Boolean(entry.attrs.RESOLUTION) === Boolean(res))
  const bandwidth = Number(wanted.attrs.BANDWIDTH ?? 0)
  return (sameShape.length ? sameShape : pool).toSorted(
    (a, b) =>
      Math.abs(Number(a.attrs.BANDWIDTH ?? 0) - bandwidth) - Math.abs(Number(b.attrs.BANDWIDTH ?? 0) - bandwidth),
  )[0]
}

// --- Media playlists ---

export interface Segment {
  url: string
  duration: number
  title: string
  /** Upstream media sequence number. */
  seq: number
  /** Program date-time in ms, explicit or carried from the previous segment. */
  pdt?: number
  discontinuity: boolean
  map?: { url: string; byterange?: string }
  /** `EXT-X-KEY` attributes, URI resolved. */
  key?: Attrs
  byterange?: string
  ad: boolean
}

export interface Media {
  targetDuration: number
  mediaSequence: number
  discontinuitySequence: number
  endList: boolean
  playlistType?: string
  segments: Segment[]
  /** Twitch only: the playlist carries an ad (`stitched-ad` anywhere, or an ad segment). */
  ad: boolean
}

/** True when a Twitch media playlist is in, or announces, a stitched ad. */
export function isAdPlaylist(text: string): boolean {
  return text.toLowerCase().includes('stitched-ad') || /#EXTINF:[\d.]+,(?!live\s*$)\S/m.test(text)
}

/**
 * Parses a media playlist. With `twitch`, segments of a stitched ad are flagged:
 * an `EXTINF` title other than `live`, or a date inside a `twitch-stitched-ad` date range.
 */
export function parseMedia(text: string, base: string, options: { twitch?: boolean } = {}): Media {
  const media: Media = {
    targetDuration: 0,
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    segments: [],
    ad: false,
  }
  const adRanges: Array<[number, number]> = []
  let pending: Partial<Segment> = {}
  let map: Segment['map']
  let key: Attrs | undefined
  for (const line of linesOf(text)) {
    if (!line.startsWith('#')) {
      const prev = media.segments.at(-1)
      const pdt = pending.pdt ?? (prev?.pdt !== undefined ? prev.pdt + prev.duration * 1000 : undefined)
      media.segments.push({
        url: resolve(line, base),
        duration: pending.duration ?? 0,
        title: pending.title ?? '',
        seq: media.mediaSequence + media.segments.length,
        pdt,
        discontinuity: pending.discontinuity ?? false,
        map,
        key,
        byterange: pending.byterange,
        ad: false,
      })
      pending = {}
    } else if (line.startsWith('#EXTINF:')) {
      const value = tagValue(line)
      const comma = value.indexOf(',')
      pending.duration = Number.parseFloat(comma < 0 ? value : value.slice(0, comma)) || 0
      pending.title = comma < 0 ? '' : value.slice(comma + 1).trim()
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) media.targetDuration = Number(tagValue(line)) || 0
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) media.mediaSequence = Number(tagValue(line)) || 0
    else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))
      media.discontinuitySequence = Number(tagValue(line)) || 0
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) media.playlistType = tagValue(line).toUpperCase()
    else if (line === '#EXT-X-ENDLIST') media.endList = true
    else if (line === '#EXT-X-DISCONTINUITY') pending.discontinuity = true
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const pdt = Date.parse(tagValue(line))
      if (!Number.isNaN(pdt)) pending.pdt = pdt
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) pending.byterange = tagValue(line)
    else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(tagValue(line))
      map = attrs.URI ? { url: resolve(attrs.URI, base), byterange: attrs.BYTERANGE } : undefined
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(tagValue(line))
      key = attrs.METHOD === 'NONE' ? undefined : { ...attrs, ...(attrs.URI ? { URI: resolve(attrs.URI, base) } : {}) }
    } else if (line.startsWith('#EXT-X-DATERANGE:') && options.twitch) {
      const attrs = parseAttrs(tagValue(line))
      const start = Date.parse(attrs['START-DATE'] ?? '')
      const duration = Number(attrs.DURATION ?? attrs['PLANNED-DURATION'] ?? 0)
      const isAd = (attrs.CLASS ?? '').includes('stitched-ad') || (attrs.ID ?? '').startsWith('stitched-ad')
      if (isAd && !Number.isNaN(start) && duration > 0) adRanges.push([start, start + duration * 1000])
    }
    // Anything else (EXT-X-TWITCH-PREFETCH, Twitch's DATERANGE/INFO tags, …) is dropped.
  }
  if (options.twitch) {
    for (const segment of media.segments) {
      const titled = segment.title !== '' && segment.title !== 'live'
      const pdt = segment.pdt
      segment.ad = titled || (pdt !== undefined && adRanges.some(([from, to]) => pdt >= from && pdt < to))
    }
    media.ad = isAdPlaylist(text) || media.segments.some((segment) => segment.ad)
  }
  return media
}

export interface MediaOut {
  targetDuration: number
  mediaSequence: number
  discontinuitySequence: number
  endList: boolean
  playlistType?: string
  segments: Segment[]
}

/** Serializes a media playlist; `uriFor` maps every upstream URL (segment, map, key) to a relay URI. */
export function serializeMedia(media: MediaOut, uriFor: (url: string) => string): string {
  const hasMap = media.segments.some((segment) => segment.map)
  const out = ['#EXTM3U', `#EXT-X-VERSION:${hasMap ? 6 : 3}`]
  const target = Math.max(1, media.targetDuration, ...media.segments.map((segment) => Math.round(segment.duration)))
  out.push(`#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${media.mediaSequence}`)
  if (media.discontinuitySequence) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${media.discontinuitySequence}`)
  if (media.playlistType) out.push(`#EXT-X-PLAYLIST-TYPE:${media.playlistType}`)
  let map: string | undefined
  let key: string | undefined
  for (const segment of media.segments) {
    if (segment.discontinuity) out.push('#EXT-X-DISCONTINUITY')
    const keyLine = segment.key ? keyTag(segment.key, uriFor) : NO_KEY
    if (keyLine !== (key ?? NO_KEY)) out.push(keyLine)
    key = keyLine
    const mapLine = segment.map
      ? `#EXT-X-MAP:URI="${uriFor(segment.map.url)}"${segment.map.byterange ? `,BYTERANGE="${segment.map.byterange}"` : ''}`
      : undefined
    if (mapLine && (mapLine !== map || segment.discontinuity)) out.push(mapLine)
    map = mapLine
    if (segment.pdt !== undefined) out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.pdt).toISOString()}`)
    out.push(`#EXTINF:${segment.duration.toFixed(3)},${segment.title}`)
    if (segment.byterange) out.push(`#EXT-X-BYTERANGE:${segment.byterange}`)
    out.push(uriFor(segment.url))
  }
  if (media.endList) out.push('#EXT-X-ENDLIST')
  return `${out.join('\n')}\n`
}

const NO_KEY = '#EXT-X-KEY:METHOD=NONE'
const UNQUOTED = new Set(['METHOD', 'IV'])

function keyTag(attrs: Attrs, uriFor: (url: string) => string): string {
  const parts = Object.entries(attrs).map(([name, value]) => {
    if (name === 'URI') return `URI="${uriFor(value)}"`
    return UNQUOTED.has(name) ? `${name}=${value}` : `${name}="${value}"`
  })
  return `#EXT-X-KEY:${parts.join(',')}`
}

// --- Rolling timeline ---

export interface Entry extends Segment {
  /** The relay's own media sequence number. */
  own: number
}

export interface Timeline {
  entries: Entry[]
  nextSeq?: number
  discontinuitySequence: number
  targetDuration: number
  /** The last upstream segment looked at (content or ad), to skip what was already seen. */
  cursor?: { seq: number; pdt?: number }
  /** Content was cut (ad removed, upstream switched, gap): the next entry starts a discontinuity. */
  cut: boolean
  ended: boolean
}

export function createTimeline(): Timeline {
  return { entries: [], discontinuitySequence: 0, targetDuration: 0, cut: false, ended: false }
}

/**
 * Appends the new content segments of an upstream poll to the timeline and trims it to `windowS` seconds.
 * New means after the cursor: by date when both sides have one, else by upstream sequence.
 * `switched` marks an upstream change (Twitch backup stream): the next segment starts a discontinuity.
 */
export function ingest(timeline: Timeline, media: Media, options: { windowS: number; switched?: boolean }): Timeline {
  if (options.switched && timeline.entries.length) timeline.cut = true
  for (const segment of media.segments) {
    const cursor = timeline.cursor
    if (cursor) {
      const newer =
        segment.pdt !== undefined && cursor.pdt !== undefined ? segment.pdt > cursor.pdt + 1 : segment.seq > cursor.seq
      if (!newer) continue
      // Missed segments. Dates can't tell: Twitch's are 2 s aligned while durations vary. A switch already cut.
      if (segment.seq !== cursor.seq + 1) timeline.cut = true
    }
    timeline.cursor = { seq: segment.seq, pdt: segment.pdt }
    if (segment.ad) {
      if (timeline.entries.length) timeline.cut = true
      continue
    }
    const own = timeline.nextSeq ?? segment.seq
    timeline.nextSeq = own + 1
    const discontinuity = timeline.entries.length > 0 && (segment.discontinuity || timeline.cut)
    timeline.entries.push({ ...segment, own, discontinuity })
    timeline.cut = false
  }
  if (media.endList) timeline.ended = true
  trim(timeline, options.windowS)
  const longest = Math.max(media.targetDuration, ...timeline.entries.map((entry) => Math.round(entry.duration)))
  timeline.targetDuration = Math.max(timeline.targetDuration, longest)
  return timeline
}

function trim(timeline: Timeline, windowS: number): void {
  let total = timeline.entries.reduce((sum, entry) => sum + entry.duration, 0)
  while (timeline.entries.length > 1) {
    const head = timeline.entries[0]
    if (!head || total - head.duration < windowS) break
    timeline.entries.shift()
    total -= head.duration
    if (head.discontinuity) timeline.discontinuitySequence++
  }
  const first = timeline.entries[0]
  // The first segment's discontinuity tag would not be written: count it in the sequence instead.
  if (first?.discontinuity) {
    first.discontinuity = false
    timeline.discontinuitySequence++
  }
}

export function timelineMedia(timeline: Timeline): MediaOut {
  return {
    targetDuration: timeline.targetDuration,
    mediaSequence: timeline.entries[0]?.own ?? timeline.nextSeq ?? 0,
    discontinuitySequence: timeline.discontinuitySequence,
    endList: timeline.ended,
    segments: timeline.entries,
  }
}
