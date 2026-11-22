import type HlsType from 'hls.js'
import { qualityLabel } from '../core/quality.ts'
import { bridgePlaylistLoader, type LoadPlaylist } from './bridge-loader.ts'
import { createControls } from './hls-controls.ts'
import type { Player, PlayerContext } from './types.ts'

export interface VideoOptions {
  /** Address to play instead of the source's own: the relay's playlist. */
  src?: string
  /**
   * Plays HLS through hls.js even where the browser plays it natively (Safari): only hls.js reports the
   * latency, caps the quality to the player's size and lists the qualities.
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
 * The volume of a video Regie keeps silent once the page may play sound: -80 dB, inaudible, but not zero.
 * Chrome pauses a muted, or volume 0, video when its tab goes to the background, and it comes back far behind
 * live.
 */
const SILENT_VOLUME = 0.0001

/**
 * Whether the page may play sound: someone has used it (sticky user activation). Until then a silent video is
 * `muted`, the only way it may autoplay; after, it plays at `SILENT_VOLUME`.
 */
function soundAllowed(): boolean {
  return (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false
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
  // Regie's own bar (`hls-controls.ts`): the native one has no quality menu and no way back to live.
  video.controls = false
  video.crossOrigin = 'anonymous'
  video.muted = context.initialVolume <= 0 && !soundAllowed()
  video.volume = Math.max(0, Math.min(1, context.initialVolume))
  video.style.cssText = 'width:100%;height:100%;display:block;background:#000;object-fit:contain'
  if (source.kind === 'live') lockRealTime(video)
  container.append(video)
  let hls: HlsType | null = null
  let destroyed = false
  let played = false
  let failed = false
  let recovered = false
  // A relayed video may still be remuxed (YouTube): its start is applied once the relay has got that far.
  let pendingStart = options.src ? source.start : undefined
  const controls = createControls(container, video, {
    live: source.kind === 'live',
    setQuality: (id) => setQuality(id),
    behind: () => {
      const edge = hls?.liveSyncPosition
      return typeof edge === 'number' && Number.isFinite(edge) ? Math.max(0, edge - video.currentTime) : null
    },
    goLive: () => {
      const edge = hls?.liveSyncPosition
      if (typeof edge === 'number' && Number.isFinite(edge)) video.currentTime = edge
      video.play().catch(() => undefined)
    },
  })
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
    const state = {
      levels,
      selected: manual >= 0 ? String(manual) : null,
      playing: current ? qualityLabel(current.height || 0, current.frameRate || 0) : null,
    }
    controls.quality(state)
    events.quality(state)
  }

  const setQuality = (id: string | null) => {
    if (!hls) return
    const index = id === null ? -1 : Number(id)
    if (!Number.isInteger(index) || index >= hls.levels.length) return
    // `nextLevel` switches from the next segment on, without stopping the picture; -1 is hls.js's own choice.
    hls.nextLevel = index
    reportQuality()
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
        instance.on(Hls.Events.LEVEL_UPDATED, applyStart)
        instance.on(Hls.Events.MANIFEST_PARSED, reportQuality)
        instance.on(Hls.Events.LEVEL_SWITCHED, reportQuality)
        instance.on(Hls.Events.LEVELS_UPDATED, reportQuality)
        instance.on(Hls.Events.FRAG_CHANGED, () => {
          if (!relayed || source.kind !== 'live') return
          const latency = instance.latency
          if (!Number.isFinite(latency) || latency <= 0) return
          controls.latency(latency)
          events.latency(latency)
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
  // The sound Regie last set. `volumechange` fires later, once per property written (the initial sound
  // above included), so only a sound that differs from it is the viewer's.
  let expected = { muted: video.muted, volume: video.volume }
  video.addEventListener('volumechange', () => {
    if (video.muted === expected.muted && video.volume === expected.volume) return
    expected = { muted: video.muted, volume: video.volume }
    events.userVolume(video.volume, video.muted)
  })

  /** The volume Regie asks for: a silent video started `muted` only because the page couldn't play sound yet. */
  let wanted = context.initialVolume
  // Once someone uses the page (a click in a player's frame counts: the page loses the focus), a video Regie
  // keeps silent stops being `muted`, or a background tab would pause it (`soundAllowed`).
  const unlock = new AbortController()
  const onActivation = () =>
    setTimeout(() => {
      if (destroyed || !soundAllowed()) return
      unlock.abort()
      if (wanted > 0 || !video.muted) return
      video.volume = SILENT_VOLUME
      video.muted = false
      expected = { muted: video.muted, volume: video.volume }
    }, 0)
  if (video.muted) {
    for (const type of ['pointerdown', 'keydown'] as const)
      window.addEventListener(type, onActivation, { capture: true, signal: unlock.signal })
    window.addEventListener('blur', onActivation, { signal: unlock.signal })
  }

  return {
    setVolume(volume) {
      wanted = volume
      const silent = volume <= 0
      // Silent at volume 0 once the page may play sound (`soundAllowed`), so it keeps playing in a background tab.
      const muted = silent && !soundAllowed()
      const level = muted ? video.volume : silent ? SILENT_VOLUME : Math.min(1, volume)
      if (muted === video.muted && level === video.volume) return
      video.muted = muted
      video.volume = level
      expected = { muted: video.muted, volume: video.volume }
    },
    setQuality,
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
      unlock.abort()
      controls.destroy()
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
      video.remove()
    },
  }
}
