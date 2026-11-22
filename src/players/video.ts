import type HlsType from 'hls.js'
import { qualityLabel } from '../core/quality.ts'
import { bridgePlaylistLoader, type LoadPlaylist } from './bridge-loader.ts'
import type { Player, PlayerContext } from './types.ts'

export interface VideoOptions {
  /** Address to play instead of the source's own: the relay's playlist. */
  src?: string
  /**
   * Plays HLS through hls.js even where the browser plays it natively (Safari): only hls.js reports the
   * latency, caps the quality to the player's size and lets Regie read the relay's ad header.
   */
  forceHls?: boolean
  /** The stream never started: the caller mounts another player in its place. */
  onFail?: () => void
  /**
   * Loads the playlists through the Regie extension instead of the network (`src` is then an address under
   * `EXTENSION_BASE`). Segments are still fetched by hls.js itself.
   */
  loadPlaylist?: LoadPlaylist
}

/** Set by the relay on each media playlist: `1` while the stream is in an ad it couldn't avoid (picture frozen). */
const AD_HEADER = 'X-Regie-Ad'

/**
 * A response header of a playlist, whichever loader hls.js used (XMLHttpRequest, fetch, or the extension's,
 * which hands over a `Response`). Both lookups ignore the header's case.
 */
function header(details: unknown, name: string): string | null {
  try {
    const xhr = details as { getResponseHeader?: (name: string) => string | null }
    if (typeof xhr?.getResponseHeader === 'function') return xhr.getResponseHeader(name)
    const response = details as { headers?: { get?: (name: string) => string | null } }
    if (typeof response?.headers?.get === 'function') return response.headers.get(name)
  } catch {
    // Not readable: no hint.
  }
  return null
}

/**
 * Pins a live video to real time. A live stream can't play faster than it is broadcast, and Regie lines
 * streams up by delaying them, never by changing their speed. Speed extensions ("Video Speed Controller")
 * force a rate on every `<video>` and set it again on each `ratechange`, so resetting it loses the fight
 * and hls.js runs dry and stalls: the element's own properties are shadowed so their writes do nothing.
 */
function lockRealTime(video: HTMLVideoElement) {
  for (const name of ['playbackRate', 'defaultPlaybackRate'] as const) {
    try {
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)?.set?.call(video, 1)
      Object.defineProperty(video, name, { configurable: true, get: () => 1, set: () => undefined })
    } catch {
      // Not lockable here: the rate stays the browser's.
    }
  }
}

/**
 * A direct `.m3u8` / `.mp4` link, or a stream from the viewer's relay, in a native video element. hls.js is
 * loaded only where HLS isn't native, or for the relay (`forceHls`).
 */
export function createVideoPlayer(context: PlayerContext, options: VideoOptions = {}): Player {
  const { source, container, events } = context
  const url = options.src ?? source.id
  const relayed = options.forceHls === true
  const video = document.createElement('video')
  video.playsInline = true
  video.autoplay = true
  video.controls = true
  video.crossOrigin = 'anonymous'
  video.muted = context.initialVolume <= 0
  video.volume = Math.max(0, Math.min(1, context.initialVolume))
  video.style.cssText = 'width:100%;height:100%;display:block;background:#000;object-fit:contain'
  if (source.kind === 'live') lockRealTime(video)
  container.append(video)
  let hls: HlsType | null = null
  let destroyed = false
  let played = false
  let failed = false
  let recovered = false
  /** The relay says the stream is in an ad: the picture is frozen, so its clock isn't reported. */
  let adOn = false
  // A relayed video may still be remuxed (YouTube): its start is applied once the relay has got that far.
  let pendingStart = options.src ? source.start : undefined
  /** The qualities of the stream hls.js plays, one per name (the best bitrate of each), best first. */
  const reportQuality = () => {
    if (!hls) return
    const seen = new Set<string>()
    const levels = hls.levels
      .map((level, index) => ({ index, height: level.height || 0, fps: level.frameRate || 0, bitrate: level.bitrate }))
      .filter((level) => level.height > 0)
      .toSorted((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate)
      .flatMap((level) => {
        const label = qualityLabel(level.height, level.fps)
        if (seen.has(label)) return []
        seen.add(label)
        return [{ id: String(level.index), label }]
      })
    const current = hls.levels[hls.currentLevel]
    // hls.js keeps the level asked for (-1: its own choice), and moves it when it drops a failing level.
    const manual = hls.manualLevel
    events.quality({
      levels,
      selected: manual >= 0 ? String(manual) : null,
      playing: current ? qualityLabel(current.height || 0, current.frameRate || 0) : null,
    })
  }

  /** Before the first picture, the caller can fall back to another player; after it, the stream is offline. */
  const fail = () => {
    if (failed || destroyed) return
    failed = true
    if (!played && options.onFail) options.onFail()
    else events.state('offline', true)
  }

  const applyStart = () => {
    if (pendingStart === undefined || !video.seekable.length) return
    if (video.seekable.end(video.seekable.length - 1) < pendingStart) return
    video.currentTime = pendingStart
    pendingStart = undefined
  }

  const native = video.canPlayType('application/vnd.apple.mpegurl') !== ''
  const playNative = () => {
    if (native) video.src = url
    else fail()
  }
  if (relayed || (/\.m3u8($|\?)/i.test(url) && !native)) {
    import('hls.js')
      .then(({ default: Hls }) => {
        if (destroyed) return
        if (!Hls.isSupported()) return playNative()
        const instance = new Hls(
          relayed
            ? {
                // The relay serves every quality: the player takes the one its monitor is shown at.
                capLevelToPlayerSize: true,
                lowLatencyMode: false,
                liveSyncDurationCount: 3,
                backBufferLength: 90,
                // A video starts at its beginning (or `source.start`), not at the end of what's remuxed.
                startPosition: source.kind === 'vod' ? 0 : -1,
                ...(options.loadPlaylist ? { pLoader: bridgePlaylistLoader(options.loadPlaylist) } : {}),
              }
            : { lowLatencyMode: true },
        )
        hls = instance
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || destroyed) return
          if (!played) return fail()
          // Once playing, one recovery attempt, then the stream is considered gone.
          if (!recovered && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            recovered = true
            instance.startLoad()
          } else if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            recovered = true
            instance.recoverMediaError()
          } else fail()
        })
        instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          const value = header(data.networkDetails, AD_HEADER)
          if (value === null) return
          const on = value.trim() === '1'
          if (on === adOn) return
          adOn = on
          events.adHint(on)
        })
        instance.on(Hls.Events.LEVEL_UPDATED, applyStart)
        instance.on(Hls.Events.MANIFEST_PARSED, reportQuality)
        instance.on(Hls.Events.LEVEL_SWITCHED, reportQuality)
        instance.on(Hls.Events.LEVELS_UPDATED, reportQuality)
        instance.on(Hls.Events.FRAG_CHANGED, () => {
          if (!relayed || source.kind !== 'live') return
          const latency = instance.latency
          if (Number.isFinite(latency) && latency > 0) events.latency(latency)
        })
        instance.loadSource(url)
        instance.attachMedia(video)
      })
      .catch(() => playNative())
  } else {
    video.src = url
  }
  if (!options.src && source.start) video.currentTime = source.start

  let ourPause = false
  video.addEventListener('playing', () => {
    played = true
    recovered = false
    events.state('playing', true)
  })
  video.addEventListener('waiting', () => events.state('buffering', true))
  video.addEventListener('pause', () => {
    events.state('paused', !ourPause)
    ourPause = false
  })
  video.addEventListener('ended', () => events.state('ended', true))
  // hls.js reports (and tries to recover from) the errors of a stream it plays.
  video.addEventListener('error', () => {
    if (!hls || !played) fail()
  })
  video.addEventListener('loadedmetadata', applyStart)
  video.addEventListener('durationchange', applyStart)
  video.addEventListener('timeupdate', () => {
    if (!adOn) events.progress(video.currentTime)
  })
  // The sound Regie last set. `volumechange` fires later, once per property written (the initial sound
  // above included), so only a sound that differs from it is the viewer's.
  let expected = { muted: video.muted, volume: video.volume }
  video.addEventListener('volumechange', () => {
    if (video.muted === expected.muted && video.volume === expected.volume) return
    expected = { muted: video.muted, volume: video.volume }
    events.userVolume(video.volume, video.muted)
  })

  return {
    setVolume(volume) {
      const muted = volume <= 0
      const level = muted ? video.volume : Math.min(1, volume)
      if (muted === video.muted && level === video.volume) return
      video.muted = muted
      video.volume = level
      expected = { muted: video.muted, volume: video.volume }
    },
    setQuality(id) {
      if (!hls) return
      const index = id === null ? -1 : Number(id)
      if (!Number.isInteger(index) || index >= hls.levels.length) return
      // `nextLevel` switches from the next segment on, without stopping the picture; -1 is hls.js's own choice.
      hls.nextLevel = index
      reportQuality()
    },
    play() {
      video.play().catch(() => undefined)
    },
    pause() {
      ourPause = true
      video.pause()
    },
    seekBy(seconds) {
      const target = video.currentTime + seconds
      const range = video.seekable
      if (!range.length) {
        video.currentTime = Math.max(0, target)
        return true
      }
      // A live window (or a video still being remuxed) can't be sought past its ends; live stays a few
      // segments behind its edge, where hls.js plays it.
      const start = range.start(0)
      let end = range.end(range.length - 1)
      const sync = hls?.liveSyncPosition
      if (source.kind === 'live' && typeof sync === 'number' && Number.isFinite(sync))
        end = Math.max(start, Math.min(end, sync))
      video.currentTime = Math.min(end, Math.max(start, target))
      return true
    },
    destroy() {
      destroyed = true
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
      video.remove()
    },
  }
}
