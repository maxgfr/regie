import { embedUrl } from '../platforms/embed.ts'
import { loadScript, makeIframe } from './load-script.ts'
import type { Player, PlayerContext } from './types.ts'

interface YTPlayer {
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getPlayerState(): number
  destroy(): void
}

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLIFrameElement, options: Record<string, unknown>) => YTPlayer
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

const SCRIPT = 'https://www.youtube.com/iframe_api'

/** The YouTube IFrame API wrapped around our own privacy-enhanced iframe. */
export function createYouTubePlayer(context: PlayerContext): Player {
  const { source, container, host, events } = context
  let wanted = context.initialVolume
  let player: YTPlayer | null = null
  let ready = false
  let ourPause = false
  let timer: ReturnType<typeof setInterval> | undefined
  // Always start muted: browsers allow muted autoplay, and the sound comes on once the player plays.
  // `origin` must be the page's exact origin (port included), or the API never answers.
  const iframe = makeIframe(
    embedUrl(source, { host, muted: true, origin: location.origin }) ?? 'about:blank',
    `YouTube ${source.id}`,
  )
  container.append(iframe)

  const apply = () => {
    if (!player || !ready) return
    if (wanted <= 0) player.mute()
    else {
      player.unMute()
      player.setVolume(Math.round(wanted * 100))
    }
  }

  loadScript(SCRIPT, (resolve) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve()
    }
  })
    .then(() => {
      if (!window.YT || !iframe.isConnected) return
      player = new window.YT.Player(iframe, {
        events: {
          onReady: () => {
            ready = true
            apply()
          },
          onStateChange: (event: { data: number }) => {
            const map: Record<number, Parameters<typeof events.state>[0]> = {
              0: 'ended',
              1: 'playing',
              2: 'paused',
              3: 'buffering',
            }
            const state = map[event.data]
            if (!state) return
            // The player starts muted; the sound comes on once it plays.
            if (state === 'playing') apply()
            events.state(state, !(state === 'paused' && ourPause))
            if (state === 'paused') ourPause = false
          },
          onError: () => events.state('offline', true),
        },
      })
      timer = setInterval(() => {
        if (!ready || !player) return
        try {
          if (player.getPlayerState() === 1) events.progress(player.getCurrentTime())
        } catch {
          // Ignored: the API is not ready yet.
        }
      }, 1000)
    })
    .catch(() => events.state('offline', true))

  return {
    setVolume(volume) {
      wanted = volume
      apply()
    },
    play() {
      if (ready) player?.playVideo()
    },
    pause() {
      if (!ready) return
      ourPause = true
      player?.pauseVideo()
    },
    seekBy(seconds) {
      if (!player || !ready) return false
      player.seekTo(Math.max(0, player.getCurrentTime() + seconds), true)
      return true
    },
    destroy() {
      clearInterval(timer)
      try {
        player?.destroy()
      } catch {
        // Already gone.
      }
      iframe.remove()
    },
  }
}
