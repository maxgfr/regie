import type { Player, PlayerContext } from './types.ts'

/** A direct `.m3u8` / `.mp4` link, in a native video element; hls.js is loaded only where HLS isn't native. */
export function createVideoPlayer(context: PlayerContext): Player {
  const { source, container, events } = context
  const video = document.createElement('video')
  video.playsInline = true
  video.autoplay = true
  video.controls = true
  video.crossOrigin = 'anonymous'
  video.muted = context.initialVolume <= 0
  video.volume = Math.max(0, Math.min(1, context.initialVolume))
  video.style.cssText = 'width:100%;height:100%;display:block;background:#000;object-fit:contain'
  container.append(video)
  let hls: { destroy(): void } | null = null
  let destroyed = false

  if (/\.m3u8($|\?)/i.test(source.id) && !video.canPlayType('application/vnd.apple.mpegurl')) {
    import('hls.js')
      .then(({ default: Hls }) => {
        if (destroyed) return
        if (!Hls.isSupported()) return events.state('offline', true)
        const instance = new Hls({ lowLatencyMode: true })
        instance.loadSource(source.id)
        instance.attachMedia(video)
        hls = instance
      })
      .catch(() => events.state('offline', true))
  } else {
    video.src = source.id
  }
  if (source.start) video.currentTime = source.start

  let ourPause = false
  video.addEventListener('playing', () => events.state('playing', true))
  video.addEventListener('waiting', () => events.state('buffering', true))
  video.addEventListener('pause', () => {
    events.state('paused', !ourPause)
    ourPause = false
  })
  video.addEventListener('ended', () => events.state('ended', true))
  video.addEventListener('error', () => events.state('offline', true))
  video.addEventListener('timeupdate', () => events.progress(video.currentTime))

  return {
    setVolume(volume) {
      video.muted = volume <= 0
      if (volume > 0) video.volume = Math.min(1, volume)
    },
    play() {
      video.play().catch(() => undefined)
    },
    pause() {
      ourPause = true
      video.pause()
    },
    seekBy(seconds) {
      video.currentTime = Math.max(0, video.currentTime + seconds)
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
