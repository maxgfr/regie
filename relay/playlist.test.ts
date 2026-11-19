import { describe, expect, test } from 'bun:test'
import {
  KICK_MASTER,
  KICK_MASTER_URL,
  KICK_MEDIA,
  TWITCH_MASTER,
  TWITCH_VOD,
  twitchLive,
  YOUTUBE_MASTER,
  YOUTUBE_MEDIA,
} from './fixtures.ts'
import {
  createTimeline,
  ingest,
  isAdPlaylist,
  matchEntry,
  parseAttrs,
  parseMaster,
  parseMedia,
  serializeMaster,
  serializeMedia,
  singleVariantMaster,
  timelineMedia,
} from './playlist.ts'

const WEAVER = 'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/source.m3u8'
const relayUri = (url: string) => `/s/x/${encodeURIComponent(url.split('/').at(-1) ?? '')}`

describe('attributes', () => {
  test('quoted values keep their commas', () => {
    expect(parseAttrs('BANDWIDTH=1,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked"')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'avc1.64002A,mp4a.40.2',
      VIDEO: 'chunked',
    })
  })
})

describe('master playlists', () => {
  test('Twitch: variants named by quality, Twitch tags dropped, URIs rewritten', () => {
    const master = parseMaster(TWITCH_MASTER, 'https://usher.ttvnw.net/api/channel/hls/x.m3u8')
    expect(master.entries.map((entry) => entry.name)).toEqual(['1080p60 (source)', '720p60', 'audio_only'])
    const out = serializeMaster(master, (entry) => `/v/s/${entry.name.replace(/\W/g, '')}.m3u8`)
    expect(out).not.toContain('TWITCH-INFO')
    expect(out).not.toContain('USER-IP')
    expect(out).not.toContain('ttvnw.net')
    expect(out.split('\n').filter((line) => line.startsWith('/v/'))).toEqual([
      '/v/s/1080p60source.m3u8',
      '/v/s/720p60.m3u8',
      '/v/s/audio_only.m3u8',
    ])
    expect(out.startsWith('#EXTM3U\n')).toBe(true)
  })

  test('YouTube: audio renditions become relay URIs too; I-frame playlists are dropped', () => {
    const master = parseMaster(YOUTUBE_MASTER, 'https://manifest.googlevideo.com/api/manifest/hls_variant/x')
    expect(master.entries.filter((entry) => entry.kind === 'media')).toHaveLength(2)
    expect(master.entries.filter((entry) => entry.kind === 'variant')).toHaveLength(2)
    let n = 0
    const out = serializeMaster(master, () => `/v/s/${n++}.m3u8`)
    expect(out).toContain('#EXT-X-MEDIA:URI="/v/s/0.m3u8",TYPE=AUDIO,GROUP-ID="233"')
    expect(out).not.toContain('googlevideo')
    expect(out).not.toContain('I-FRAME')
  })

  test('Kick (IVS): relative URIs are resolved against the master URL', () => {
    const master = parseMaster(KICK_MASTER, KICK_MASTER_URL)
    expect(master.entries[0]?.url).toBe(
      'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/1080p60/playlist.m3u8',
    )
    expect(serializeMaster(master, () => '/v/a/b.m3u8')).not.toContain('SESSION-DATA')
  })

  test('the same variant is found in another master by name, then resolution, then bandwidth', () => {
    const a = parseMaster(TWITCH_MASTER, WEAVER)
    const b = parseMaster(TWITCH_MASTER.replaceAll('fra05', 'ams02'), WEAVER)
    const source = a.entries[0]
    if (!source) throw new Error('no entry')
    expect(matchEntry(b.entries, source)?.url).toContain('ams02.hls.ttvnw.net/v1/playlist/source.m3u8')
    const autoplay = parseMaster(KICK_MASTER, KICK_MASTER_URL)
    expect(matchEntry(autoplay.entries, source)?.attrs.RESOLUTION).toBe('1920x1080')
    const audio = a.entries[2]
    if (!audio) throw new Error('no entry')
    expect(matchEntry(autoplay.entries, audio)?.attrs.BANDWIDTH).toBe('630000')
  })

  test('a media-only upstream gets a one-variant master', () => {
    const master = singleVariantMaster('file:///tmp/x/index.m3u8', { CODECS: 'avc1.640028,mp4a.40.2' })
    expect(serializeMaster(master, () => '/v/a/b.m3u8')).toBe(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"\n/v/a/b.m3u8\n',
    )
  })
})

describe('media playlists', () => {
  test('Twitch live: segments, dates, no prefetch', () => {
    const media = parseMedia(twitchLive(1000, 4, { prefetch: true }), WEAVER, { twitch: true })
    expect(media.mediaSequence).toBe(1000)
    expect(media.segments.map((segment) => segment.seq)).toEqual([1000, 1001, 1002, 1003])
    expect(media.segments.every((segment) => !segment.ad)).toBe(true)
    expect(media.ad).toBe(false)
    const out = serializeMedia({ ...media, segments: media.segments }, relayUri)
    expect(out).not.toContain('PREFETCH')
    expect(out).not.toContain('DATERANGE')
    expect(out).not.toContain('TWITCH')
    expect(out.match(/#EXT-X-PROGRAM-DATE-TIME/g)).toHaveLength(4)
  })

  test('Twitch stitched ad: flagged by title and by date range', () => {
    const text = twitchLive(1000, 6, { ad: [1002, 1003] })
    expect(isAdPlaylist(text)).toBe(true)
    expect(isAdPlaylist(twitchLive(1000, 6))).toBe(false)
    const media = parseMedia(text, WEAVER, { twitch: true })
    expect(media.ad).toBe(true)
    expect(media.segments.map((segment) => segment.ad)).toEqual([false, false, true, true, false, false])
    // A segment inside the date range is an ad even when titled `live`.
    const dated = parseMedia(text.replace('#EXTINF:2.000,Amazon', '#EXTINF:2.000,live'), WEAVER, { twitch: true })
    expect(dated.segments[2]?.ad).toBe(true)
  })

  test('titles only mean ads on Twitch', () => {
    expect(parseMedia(twitchLive(1000, 3, { ad: [1001] }), WEAVER).segments.some((segment) => segment.ad)).toBe(false)
  })

  test('YouTube: one date carried to every segment', () => {
    const media = parseMedia(YOUTUBE_MEDIA, 'https://manifest.googlevideo.com/x/index.m3u8')
    expect(media.discontinuitySequence).toBe(51)
    const [first, second] = media.segments
    expect(first?.pdt).toBe(Date.parse('2026-11-19T12:11:36.431Z'))
    expect(second?.pdt).toBe(Date.parse('2026-11-19T12:11:41.431Z'))
  })

  test('fMP4: EXT-X-MAP resolved and rewritten', () => {
    const media = parseMedia(KICK_MEDIA, 'https://cdn.example/1080p60/playlist.m3u8')
    expect(media.segments[0]?.map?.url).toBe('https://cdn.example/1080p60/init-0.mp4')
    const out = serializeMedia(media, relayUri)
    expect(out).toContain('#EXT-X-VERSION:6')
    expect(out.match(/#EXT-X-MAP:URI="\/s\/x\/init-0.mp4"/g)).toHaveLength(1)
  })

  test('VOD: served whole with ENDLIST and its type', () => {
    const media = parseMedia(TWITCH_VOD, 'https://d2nvs31859zcd8.cloudfront.net/abc/chunked/index-dvr.m3u8')
    expect(media.endList).toBe(true)
    expect(media.segments[1]?.url).toBe('https://d2nvs31859zcd8.cloudfront.net/abc/chunked/1-muted.ts')
    const out = serializeMedia(media, relayUri)
    expect(out).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(out.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
    expect(out).toContain('#EXT-X-TARGETDURATION:10')
  })
})

describe('timeline', () => {
  const poll = (seq: number, count: number, ad: number[] = []) =>
    parseMedia(twitchLive(seq, count, { ad }), WEAVER, { twitch: true })

  test('short segments with 2 s aligned dates are not a gap', () => {
    const timeline = createTimeline()
    const short = twitchLive(1000, 3).replace('#EXTINF:2.000,live', '#EXTINF:0.900,live')
    ingest(timeline, parseMedia(short, WEAVER, { twitch: true }), { windowS: 180 })
    expect(timeline.entries.some((entry) => entry.discontinuity)).toBe(false)
  })

  test('two overlapping polls: no duplicate, own sequence continues', () => {
    const timeline = createTimeline()
    ingest(timeline, poll(1000, 5), { windowS: 180 })
    ingest(timeline, poll(1003, 5), { windowS: 180 })
    expect(timeline.entries.map((entry) => entry.seq)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])
    expect(timeline.entries.map((entry) => entry.own)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])
    expect(timeline.entries.some((entry) => entry.discontinuity)).toBe(false)
    const out = serializeMedia(timelineMedia(timeline), relayUri)
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:1000')
  })

  test('ads are cut out: the sequence stays contiguous and a discontinuity marks the cut', () => {
    const timeline = createTimeline()
    ingest(timeline, poll(1000, 4, [1002, 1003]), { windowS: 180 })
    ingest(timeline, poll(1002, 5, [1002, 1003, 1004]), { windowS: 180 })
    ingest(timeline, poll(1004, 4, [1004]), { windowS: 180 })
    expect(timeline.entries.map((entry) => entry.seq)).toEqual([1000, 1001, 1005, 1006, 1007])
    expect(timeline.entries.map((entry) => entry.own)).toEqual([1000, 1001, 1002, 1003, 1004])
    expect(timeline.entries.map((entry) => entry.discontinuity)).toEqual([false, false, true, false, false])
    const out = serializeMedia(timelineMedia(timeline), relayUri)
    expect(out).not.toContain('Amazon')
    expect(out.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(1)
  })

  test('an upstream switch starts a discontinuity; dates keep the switch free of repeats', () => {
    const timeline = createTimeline()
    ingest(timeline, poll(1000, 3), { windowS: 180 })
    // The backup stream has other sequence numbers but the same broadcast dates.
    const backup = parseMedia(twitchLive(1001, 4).replaceAll('MEDIA-SEQUENCE:1001', 'MEDIA-SEQUENCE:77'), WEAVER, {
      twitch: true,
    })
    ingest(timeline, backup, { windowS: 180, switched: true })
    expect(timeline.entries.map((entry) => entry.own)).toEqual([1000, 1001, 1002, 1003, 1004])
    expect(timeline.entries.map((entry) => entry.discontinuity)).toEqual([false, false, false, true, false])
  })

  test('the window is trimmed to WINDOW_S and the discontinuity sequence follows', () => {
    const timeline = createTimeline()
    ingest(timeline, poll(1000, 4, [1002]), { windowS: 180 })
    expect(timeline.entries.map((entry) => entry.discontinuity)).toEqual([false, false, true])
    ingest(timeline, poll(1004, 10), { windowS: 10 })
    expect(timeline.entries.map((entry) => entry.own)).toEqual([1008, 1009, 1010, 1011, 1012])
    expect(timeline.discontinuitySequence).toBe(1)
    const out = serializeMedia(timelineMedia(timeline), relayUri)
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:1008')
    expect(out).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1')
  })

  test('a first poll during an ad starts empty, then fills', () => {
    const timeline = createTimeline()
    ingest(timeline, poll(1000, 3, [1000, 1001, 1002]), { windowS: 180 })
    expect(timeline.entries).toHaveLength(0)
    ingest(timeline, poll(1002, 3, [1002]), { windowS: 180 })
    expect(timeline.entries.map((entry) => [entry.own, entry.discontinuity])).toEqual([
      [1003, false],
      [1004, false],
    ])
  })

  test('sequence-only upstreams: a gap is a discontinuity, ENDLIST ends the timeline', () => {
    const timeline = createTimeline()
    const base = 'https://manifest.googlevideo.com/x/index.m3u8'
    const noDates = YOUTUBE_MEDIA.replace(/#EXT-X-PROGRAM-DATE-TIME:.*\n/, '')
    ingest(timeline, parseMedia(noDates, base), { windowS: 180 })
    const later = noDates.replace('MEDIA-SEQUENCE:272298', 'MEDIA-SEQUENCE:272310')
    ingest(timeline, parseMedia(`${later}#EXT-X-ENDLIST\n`, base), { windowS: 180 })
    expect(timeline.entries.map((entry) => entry.own)).toEqual([272298, 272299, 272300, 272301, 272302, 272303])
    expect(timeline.entries[3]?.discontinuity).toBe(true)
    expect(timeline.ended).toBe(true)
    expect(serializeMedia(timelineMedia(timeline), relayUri).trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })
})
