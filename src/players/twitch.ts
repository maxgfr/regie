import { parseTwitchQuality, pickQuality, type Quality } from '../core/quality.ts'
import { loadScript } from './load-script.ts'
import type { Player, PlayerContext } from './types.ts'

interface TwitchPlayer {
  addEventListener(event: string, callback: () => void): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  play(): void
  pause(): void
  seek(time: number): void
  getCurrentTime(): number
  isPaused(): boolean
  getPlaybackStats(): { hlsLatencyBroadcaster?: number } | undefined
  getQualities(): { group?: string; name?: string }[]
  setQuality(quality: string): void
  getIframe?(): HTMLIFrameElement
}

interface TwitchGlobal {
  Player: {
    new (element: HTMLElement, options: Record<string, unknown>): TwitchPlayer
    READY: string
    PLAY: string
    PLAYING: string
    PAUSE: string
    ENDED: string
    ONLINE: string
    OFFLINE: string
    PLAYBACK_BLOCKED: string
  }
}

declare global {
  interface Window {
    Twitch?: TwitchGlobal
  }
}

const SCRIPT = 'https://player.twitch.tv/js/embed/v1.js'

/** Twitch's official Embed JS: volume, mute, VOD seek, and the live latency in its playback stats. */
export function createTwitchPlayer(context: PlayerContext): Player {
  const { source, container, host, events } = context
  let player: TwitchPlayer | null = null
  let ready = false
  let destroyed = false
  let wanted = context.initialVolume
  let timer: ReturnType<typeof setInterval> | undefined
  const element = document.createElement('div')
  element.style.cssText = 'width:100%;height:100%'
  container.append(element)
  let inAd = false

  // The player iframe reports its full state to the page. During an ad, Twitch reports `Idle` playback
  // while video frames keep coming: that is the only ad signal an embed gets (observed, undocumented).
  // Autoplay with sound can be refused (PLAYBACK_BLOCKED): the player starts muted, and the sound only comes
  // on once it really plays. Ads are always silent here: another stream carries the sound meanwhile.
  let playing = false
  let adStreak = 0
  const expectMuted = () => wanted <= 0 || !playing || inAd
  // When Regie last changed the sound, or the player changed state: differences right after are the player's
  // own doing (it restores its state around ads and starts), not the viewer's.
  let settledAt = 0
  const apply = () => {
    if (!player || !ready) return
    settledAt = Date.now()
    player.setMuted(expectMuted())
    if (wanted > 0) player.setVolume(wanted)
  }

  // Quality follows the monitor's size; only changed when the choice changes, and once the stream plays.
  let fitting: { height: number; main: boolean } | null = null
  let quality = ''
  const applyQuality = () => {
    if (!player || !ready || !playing || inAd || !fitting) return
    try {
      const available = player
        .getQualities()
        .map((q) => parseTwitchQuality(q.group ?? ''))
        .filter((q): q is Quality => q !== null)
      // Device pixels count, but only up to 1.25×: on a Retina wall a small monitor at 360p looks the
      // same and costs a third of 720p.
      const density = Math.min(window.devicePixelRatio || 1, 1.25)
      const next = pickQuality(available, Math.round(fitting.height * density), fitting.main)
      if (next === quality) return
      quality = next
      player.setQuality(next)
    } catch {
      // Qualities aren't known yet; the next fit or the next "playing" tries again.
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== 'https://player.twitch.tv') return
    if (event.source !== element.querySelector('iframe')?.contentWindow) return
    const update = readUpdate(event.data)
    if (!update) return
    if (update.latency && update.latency > 0) events.latency(update.latency)
    // Two messages in a row (about two seconds), so a stream that is just starting doesn't flash "ad".
    adStreak = update.playback === 'Idle' && update.fps > 0 ? adStreak + 1 : 0
    const ad = adStreak >= 2 ? true : update.playback === 'Playing' ? false : inAd
    if (ad !== inAd) {
      inAd = ad
      if (!ad) playing = true
      events.adHint(ad)
      apply()
    }
    if (!ready || update.muted === undefined) return
    const differs =
      update.muted !== expectMuted() ||
      (!update.muted && update.volume !== undefined && Math.abs(update.volume - wanted) > 0.02)
    if (!differs) return
    if (inAd || !playing || Date.now() - settledAt < 3000) {
      // Twitch put its own state back (after an ad or a start): Regie's mix wins.
      apply()
    } else {
      // The viewer used the player's own mute button or slider: that becomes Regie's setting.
      wanted = update.muted ? 0 : (update.volume ?? wanted)
      settledAt = Date.now()
      events.userVolume(update.volume ?? wanted, update.muted)
    }
  }
  window.addEventListener('message', onMessage)

  loadScript(SCRIPT)
    .then(() => {
      const Twitch = window.Twitch
      if (destroyed || !Twitch) return
      const options: Record<string, unknown> = {
        width: '100%',
        height: '100%',
        parent: [host],
        autoplay: true,
        muted: true,
      }
      if (source.kind === 'vod') {
        options.video = `v${source.id}`
        if (source.start) options.time = `${Math.floor(source.start)}s`
      } else options.channel = source.id
      const instance = new Twitch.Player(element, options)
      player = instance
      instance.addEventListener(Twitch.Player.READY, () => {
        ready = true
        apply()
      })
      instance.addEventListener(Twitch.Player.PLAYING, () => {
        playing = true
        apply()
        quality = ''
        applyQuality()
        events.state('playing', true)
      })
      instance.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
        playing = false
        instance.setMuted(true)
        instance.play()
      })
      instance.addEventListener(Twitch.Player.PLAY, () => events.state('buffering', true))
      // Ads come from the player's state messages; a Twitch pause is never read as an ad.
      instance.addEventListener(Twitch.Player.PAUSE, () => events.state('paused', false))
      instance.addEventListener(Twitch.Player.ENDED, () => events.state('ended', true))
      instance.addEventListener(Twitch.Player.OFFLINE, () => events.state('offline', true))
      instance.addEventListener(Twitch.Player.ONLINE, () => events.state('buffering', true))
      timer = setInterval(() => {
        if (!ready || !player) return
        try {
          if (source.kind === 'vod') events.progress(player.getCurrentTime())
          const latency = player.getPlaybackStats()?.hlsLatencyBroadcaster
          if (typeof latency === 'number' && latency > 0) events.latency(latency)
        } catch {
          // The player can throw while it switches streams.
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
      if (ready) player?.play()
    },
    pause() {
      if (ready) player?.pause()
    },
    seekBy(seconds) {
      if (!player || !ready || source.kind !== 'vod') return false
      player.seek(Math.max(0, player.getCurrentTime() + seconds))
      return true
    },
    fit(displayHeight, main) {
      fitting = { height: displayHeight, main }
      applyQuality()
    },
    destroy() {
      destroyed = true
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
      element.remove()
    },
  }
}

interface TwitchUpdate {
  playback: string
  fps: number
  latency?: number
  muted?: boolean
  volume?: number
}

/** Reads the `UPDATE_STATE` message the Twitch player iframe posts to its host page. */
export function readUpdate(data: unknown): TwitchUpdate | null {
  if (!data || typeof data !== 'object') return null
  const message = data as { eventName?: unknown; params?: Record<string, unknown> }
  if (message.eventName !== 'UPDATE_STATE' || !message.params) return null
  const { playback, stats, muted, volume } = message.params
  if (typeof playback !== 'string') return null
  const video = (stats as { videoStats?: { fps?: unknown; hlsLatencyBroadcaster?: unknown } } | undefined)?.videoStats
  return {
    playback,
    fps: typeof video?.fps === 'number' ? video.fps : 0,
    latency: typeof video?.hlsLatencyBroadcaster === 'number' ? video.hlsLatencyBroadcaster : undefined,
    muted: typeof muted === 'boolean' ? muted : undefined,
    volume: typeof volume === 'number' ? volume : undefined,
  }
}
