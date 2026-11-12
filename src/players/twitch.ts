import {
  decayStalls,
  initialStalls,
  parseTwitchQuality,
  pickQuality,
  type Quality,
  recordStall,
} from '../core/quality.ts'
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

/** Twitch only autoplays, and only counts its ads down, in a player of at least this size. */
export const TWITCH_MIN_WIDTH = 400
export const TWITCH_MIN_HEIGHT = 300

/**
 * Ads, as the player's state messages show them (observed, undocumented):
 * - `Buffering` while the buffer holds many seconds: the stream waits behind an ad. A real stall has an
 *   empty buffer. Held for `AD_SIGNAL_MS`.
 * - `Idle` while frames keep coming. A paused live player looks the same for about seven seconds, so this
 *   one only counts after `AD_IDLE_MS`, and never after a pause Regie sent.
 */
export const AD_SIGNAL_MS = 3000
export const AD_IDLE_MS = 10_000
export const AD_MIN_BUFFER_S = 10
export const AD_MIN_FPS = 10
/** Below this much buffer, a rebuffer is a real stall: the connection didn't keep up. */
const STALL_BUFFER_S = 0.5
/** Leave the quality change a moment to settle before reading a rebuffer as a stall. */
const SWITCH_SETTLE_MS = 6000
/** Wait for the layout to settle before matching the quality to it (a line check or an ad boost is brief). */
const FIT_DELAY_MS = 1500

/** Official Embed JS: volume, mute, VOD seek, quality and the live latency in its playback stats. */
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
  let frame: HTMLIFrameElement | null = null

  // The player iframe reports its full state to the page about twice a second: the only ad signal an embed
  // gets (see `adSignature`).
  let inAd = false
  let adKind: AdSignature = null
  let adSince = 0
  let pausedByRegie = false
  let lastPlayback = ''
  // Autoplay with sound can be refused (PLAYBACK_BLOCKED): the player starts muted, and the sound only comes
  // on once it really plays. Ads are always silent here: another stream carries the sound meanwhile.
  let playing = false
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

  // Quality follows the monitor's size. It is only sent when the choice changes: every `setQuality` flushes
  // the player's buffer, so sending it again on each "playing" would stall the stream in a loop.
  let fitting: { height: number; main: boolean } | null = null
  let fitTimer: ReturnType<typeof setTimeout> | undefined
  let quality = 'auto'
  let switchedAt = 0
  let stalls = initialStalls(Date.now())
  const applyQuality = () => {
    if (!player || !ready || !playing || inAd || !fitting) return
    try {
      const available = player
        .getQualities()
        .map((q) => parseTwitchQuality(q.group ?? ''))
        .filter((q): q is Quality => q !== null)
      if (!available.length) return
      // Device pixels count, but only up to 1.25×: on a Retina wall a small monitor at 360p looks the
      // same and costs a third of 720p.
      const density = Math.min(window.devicePixelRatio || 1, 1.25)
      const next = pickQuality(available, Math.round(fitting.height * density), fitting.main, stalls.penalty)
      if (next === quality) return
      quality = next
      switchedAt = Date.now()
      player.setQuality(next)
    } catch {
      // Qualities aren't known yet; the next fit or the next "playing" tries again.
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== 'https://player.twitch.tv') return
    frame ??= element.querySelector('iframe')
    if (!frame || event.source !== frame.contentWindow) return
    const update = readUpdate(event.data)
    if (!update) return
    const now = Date.now()
    if (update.latency && update.latency > 0) events.latency(update.latency)
    // A rebuffer with an empty buffer at a quality Regie forced: the connection may not keep up with it.
    if (update.playback === 'Buffering' && lastPlayback === 'Playing' && quality !== 'auto' && !inAd) {
      if (now - switchedAt > SWITCH_SETTLE_MS && (update.buffer ?? 0) < STALL_BUFFER_S) {
        const before = stalls.penalty
        stalls = recordStall(stalls, now)
        if (stalls.penalty !== before) applyQuality()
      }
    }
    lastPlayback = update.playback
    let signature = adSignature(update)
    if (signature === 'idle' && pausedByRegie) signature = null
    if (signature !== adKind) {
      adKind = signature
      adSince = now
    }
    const held = adKind !== null && now - adSince >= (adKind === 'idle' ? AD_IDLE_MS : AD_SIGNAL_MS)
    const ad = held ? true : update.playback === 'Playing' ? false : inAd
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
    if (inAd || !playing || now - settledAt < 3000) {
      // Twitch put its own state back (after an ad or a start): Regie's mix wins.
      apply()
    } else {
      // The viewer used the player's own mute button or slider: that becomes Regie's setting.
      wanted = update.muted ? 0 : (update.volume ?? wanted)
      settledAt = now
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
        const first = !playing
        playing = true
        pausedByRegie = false
        if (first) apply()
        // Only does something if the qualities weren't known yet, or the monitor changed size meanwhile.
        applyQuality()
        events.state('playing', true)
      })
      instance.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
        playing = false
        instance.setMuted(true)
        instance.play()
      })
      instance.addEventListener(Twitch.Player.PLAY, () => events.state('buffering', true))
      // Twitch also sends PAUSE when it rebuffers. Ads come from the state messages; a pause is never an ad.
      instance.addEventListener(Twitch.Player.PAUSE, () => events.state('paused', false))
      instance.addEventListener(Twitch.Player.ENDED, () => events.state('ended', true))
      instance.addEventListener(Twitch.Player.OFFLINE, () => events.state('offline', true))
      instance.addEventListener(Twitch.Player.ONLINE, () => events.state('buffering', true))
      timer = setInterval(() => {
        if (!ready || !player) return
        const relaxed = decayStalls(stalls, Date.now())
        if (relaxed !== stalls) {
          stalls = relaxed
          applyQuality()
        }
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
      pausedByRegie = false
      if (ready) player?.play()
    },
    pause() {
      if (!ready) return
      pausedByRegie = true
      player?.pause()
    },
    seekBy(seconds) {
      if (!player || !ready || source.kind !== 'vod') return false
      player.seek(Math.max(0, player.getCurrentTime() + seconds))
      return true
    },
    fit(displayHeight, main) {
      fitting = { height: displayHeight, main }
      clearTimeout(fitTimer)
      fitTimer = setTimeout(applyQuality, FIT_DELAY_MS)
    },
    destroy() {
      destroyed = true
      clearInterval(timer)
      clearTimeout(fitTimer)
      window.removeEventListener('message', onMessage)
      element.remove()
    },
  }
}

interface TwitchUpdate {
  playback: string
  fps: number
  /** Seconds of video buffered ahead. */
  buffer?: number
  latency?: number
  muted?: boolean
  volume?: number
}

type AdSignature = 'buffering' | 'idle' | null

/** Which ad signature a state message shows, if any (see `AD_SIGNAL_MS` and `AD_IDLE_MS`). */
export function adSignature(update: TwitchUpdate | null): AdSignature {
  if (!update) return null
  if (update.playback === 'Buffering' && (update.buffer ?? 0) >= AD_MIN_BUFFER_S) return 'buffering'
  if (update.playback === 'Idle' && update.fps >= AD_MIN_FPS) return 'idle'
  return null
}

/** Reads the `UPDATE_STATE` message the Twitch player iframe posts to its host page. */
export function readUpdate(data: unknown): TwitchUpdate | null {
  if (!data || typeof data !== 'object') return null
  const message = data as { eventName?: unknown; params?: Record<string, unknown> }
  if (message.eventName !== 'UPDATE_STATE' || !message.params) return null
  const { playback, stats, muted, volume } = message.params
  if (typeof playback !== 'string') return null
  const video = (
    stats as { videoStats?: { fps?: unknown; bufferSize?: unknown; hlsLatencyBroadcaster?: unknown } } | undefined
  )?.videoStats
  return {
    playback,
    fps: typeof video?.fps === 'number' ? video.fps : 0,
    buffer: typeof video?.bufferSize === 'number' ? video.bufferSize : undefined,
    latency: typeof video?.hlsLatencyBroadcaster === 'number' ? video.hlsLatencyBroadcaster : undefined,
    muted: typeof muted === 'boolean' ? muted : undefined,
    volume: typeof volume === 'number' ? volume : undefined,
  }
}
