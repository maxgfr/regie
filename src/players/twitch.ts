import {
  decayStalls,
  initialStalls,
  nextQuality,
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

/** Twitch only autoplays a player of at least this size. */
export const TWITCH_MIN_WIDTH = 400
export const TWITCH_MIN_HEIGHT = 300

/** What the player iframe reports about itself, about twice a second (observed, undocumented). */
export interface TwitchUpdate {
  playback: string
  /** The stream's own clock, in seconds. */
  time?: number
  /** Seconds of video buffered ahead. */
  buffer?: number
  latency?: number
  muted?: boolean
  volume?: number
}

/** Below this much buffer, a rebuffer is a real stall: the connection didn't keep up. */
const STALL_BUFFER_S = 0.5
/** Leave the quality change a moment to settle before reading a rebuffer as a stall. */
const SWITCH_SETTLE_MS = 6000
/** Wait for the layout to settle before matching the quality to it (a line check is brief). */
const FIT_DELAY_MS = 1500
/** A monitor made smaller waits longer: the viewer often switches layouts back and forth. */
const FIT_SMALL_DELAY_MS = 6000
/**
 * A quality switch takes a moment: Twitch reports "Buffering" with hundreds of seconds of buffer, then plays
 * with its clock at 0. The switch is over once the stream itself plays again, or after this long.
 */
const SWITCH_GRACE_MS = 15_000
/**
 * The quality is only changed once the stream itself has played this long. A `setQuality` in the player's
 * first seconds freezes it until someone clicks it: observed with Twitch's "preparing your stream" pre-roll,
 * which starts a few seconds after the player.
 */
const CONTENT_SETTLE_MS = 5000

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

  // The player iframe reports its full state to the page about twice a second (`readUpdate`).
  let lastPlayback = ''
  const live = source.kind !== 'vod'
  // Since when the stream itself has been playing without a break.
  let contentSince: number | null = null
  // Autoplay with sound can be refused (PLAYBACK_BLOCKED): the player starts muted, and the sound only comes
  // on once it really plays.
  let playing = false
  const expectMuted = () => wanted <= 0 || !playing
  // When Regie last changed the sound, or the player changed state: differences right after are the player's
  // own doing (it restores its saved state as it starts), not the viewer's.
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
  let qualityDirty = false
  // A switch Regie asked for and the stream hasn't come back from yet.
  let switching = false
  // A stall penalty changed: switch even where the size alone wouldn't be worth it.
  let forceQuality = false
  const applyQuality = (force = false) => {
    qualityDirty = true
    if (force) forceQuality = true
    if (!player || !ready || !fitting) return
    if (contentSince === null || Date.now() - contentSince < CONTENT_SETTLE_MS) return
    try {
      const available = player
        .getQualities()
        .map((q) => parseTwitchQuality(q.group ?? ''))
        .filter((q): q is Quality => q !== null)
      if (!available.length) return
      qualityDirty = false
      // Device pixels count, but only up to 1.25×: on a Retina wall a small monitor at 360p looks the
      // same and costs a third of 720p.
      const density = Math.min(window.devicePixelRatio || 1, 1.25)
      const height = Math.round(fitting.height * density)
      const next = forceQuality
        ? pickQuality(available, height, fitting.main, stalls.penalty)
        : nextQuality(quality, available, height, fitting.main, stalls.penalty)
      forceQuality = false
      if (next === quality) return
      quality = next
      switchedAt = Date.now()
      switching = true
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
    if (update.playback === 'Buffering' && lastPlayback === 'Playing' && quality !== 'auto') {
      if (now - switchedAt > SWITCH_SETTLE_MS && (update.buffer ?? 0) < STALL_BUFFER_S) {
        const before = stalls.penalty
        stalls = recordStall(stalls, now)
        if (stalls.penalty !== before) applyQuality(true)
      }
    }
    lastPlayback = update.playback
    const switchExpired = switching && now - switchedAt > SWITCH_GRACE_MS
    // What plays is the stream itself: a live one reports how far behind the broadcaster it is (Twitch's own
    // pre-roll has no broadcaster). Nothing counts while the page is hidden: Twitch pauses what nobody sees.
    const content =
      !document.hidden && update.playback === 'Playing' && (!live || update.latency === undefined || update.latency > 0)
    contentSince = content ? (contentSince ?? now) : null
    if (switching && content && update.time) switching = false
    else if (switchExpired) {
      switching = false
      // Twitch sometimes stays stuck after a switch until someone clicks the player: start it again.
      if (update.playback !== 'Playing') {
        try {
          player?.play()
        } catch {
          // Nothing more to do: the viewer can still click the player.
        }
      }
    }
    // A size change waited for the stream itself to play steadily.
    if (qualityDirty && contentSince !== null && now - contentSince >= CONTENT_SETTLE_MS) applyQuality()
    if (!ready || update.muted === undefined) return
    const differs =
      update.muted !== expectMuted() ||
      (!update.muted && update.volume !== undefined && Math.abs(update.volume - wanted) > 0.02)
    if (!differs) return
    // Twitch puts its own saved sound back on its own (around ads, starts, quality switches): only a change made
    // while the viewer is inside this player (it has the focus) is theirs.
    const byViewer = playing && now - settledAt >= 1000 && frame !== null && document.activeElement === frame
    if (!byViewer) {
      // Regie's mix wins.
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
        if (first) apply()
        // The quality waits for the stream itself: this "playing" may well be the start of a pre-roll.
        events.state('playing', true)
      })
      instance.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
        playing = false
        instance.setMuted(true)
        instance.play()
      })
      instance.addEventListener(Twitch.Player.PLAY, () => events.state('buffering', true))
      // Twitch also sends PAUSE when it rebuffers, and when Regie switches its quality (that one isn't the
      // viewer's).
      instance.addEventListener(Twitch.Player.PAUSE, () =>
        switching ? events.state('buffering', true) : events.state('paused', false),
      )
      instance.addEventListener(Twitch.Player.ENDED, () => events.state('ended', true))
      instance.addEventListener(Twitch.Player.OFFLINE, () => events.state('offline', true))
      instance.addEventListener(Twitch.Player.ONLINE, () => events.state('buffering', true))
      timer = setInterval(() => {
        if (!ready || !player) return
        const relaxed = decayStalls(stalls, Date.now())
        if (relaxed !== stalls) {
          stalls = relaxed
          applyQuality(true)
        }
        try {
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
      clearTimeout(fitTimer)
      fitTimer = setTimeout(() => applyQuality(), main ? FIT_DELAY_MS : FIT_SMALL_DELAY_MS)
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

/** Reads the `UPDATE_STATE` message the Twitch player iframe posts to its host page. */
export function readUpdate(data: unknown): TwitchUpdate | null {
  if (!data || typeof data !== 'object') return null
  const message = data as { eventName?: unknown; params?: Record<string, unknown> }
  if (message.eventName !== 'UPDATE_STATE' || !message.params) return null
  const { playback, stats, muted, volume, currentTime } = message.params
  if (typeof playback !== 'string') return null
  const video = (stats as { videoStats?: { bufferSize?: unknown; hlsLatencyBroadcaster?: unknown } } | undefined)
    ?.videoStats
  return {
    playback,
    time: typeof currentTime === 'number' ? currentTime : undefined,
    buffer: typeof video?.bufferSize === 'number' ? video.bufferSize : undefined,
    latency: typeof video?.hlsLatencyBroadcaster === 'number' ? video.hlsLatencyBroadcaster : undefined,
    muted: typeof muted === 'boolean' ? muted : undefined,
    volume: typeof volume === 'number' ? volume : undefined,
  }
}
