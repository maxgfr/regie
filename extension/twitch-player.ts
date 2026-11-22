/**
 * Content script on www.twitch.tv (isolated world): plays the channel or video of the page in Regie's own HLS
 * player (`src/players/video.ts`, hls.js, with Regie's controls), on top of Twitch's player, which is paused
 * and muted underneath. The playlists come from the extension's engine (the relay's, in the service worker):
 * no ads, the quality menu, and silent playback that keeps going in a background tab. When ours can't play
 * (offline channel, error before the first picture), it goes away and Twitch's player plays again.
 */
import {
  EXTENSION_BASE,
  failedReply,
  isRelayReply,
  RELAY_MESSAGE,
  type RelayRequest,
} from '../src/core/extension-protocol.ts'
import { relayUrl } from '../src/core/relay.ts'
import type { Source } from '../src/core/types.ts'
import type { Player } from '../src/players/types.ts'
import { createVideoPlayer } from '../src/players/video.ts'
import { pageSource } from './twitch-page.ts'

/** The root of Twitch's player, on a channel page and in the small corner player alike. */
const PLAYER_ROOT = '[data-a-target="video-player"]'
const VOLUME_KEY = 'regie:volume'
const OVERLAY_CSS = 'position:absolute;inset:0;z-index:2147483000;background:#000'

async function loadPlaylist(path: string) {
  try {
    const request: RelayRequest = { type: RELAY_MESSAGE, url: path }
    const reply = await chrome.runtime.sendMessage<unknown>(request)
    return isRelayReply(reply) ? reply : failedReply()
  } catch {
    // The extension was reloaded: this script is orphaned until the page reloads.
    return failedReply()
  }
}

function savedVolume(): number {
  const value = Number(localStorage.getItem(VOLUME_KEY) ?? 1)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

/** The page may play sound once someone used it; until then the player starts muted, or it couldn't start. */
function soundAllowed(): boolean {
  return (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false
}

interface Mounted {
  key: string
  root: HTMLElement
  overlay: HTMLElement
  player: Player
  twitchVideo: HTMLVideoElement | null
  stop: AbortController
}

let mounted: Mounted | null = null
/** The page ours couldn't play: Twitch's player keeps it until the viewer goes elsewhere. */
let failedKey = ''

/** Twitch's own video in its player: never ours, which sits in the same root. */
function twitchVideoIn(root: HTMLElement): HTMLVideoElement | null {
  return [...root.querySelectorAll('video')].find((video) => !video.closest('[data-regie]')) ?? null
}

/** Twitch's own video: silent and paused while ours plays, whatever Twitch asks of it. */
function hush(video: HTMLVideoElement | null, signal: AbortSignal) {
  if (!video) return
  const quiet = () => {
    video.muted = true
    if (!video.paused) video.pause()
  }
  quiet()
  video.addEventListener('play', quiet, { signal })
  video.addEventListener('playing', quiet, { signal })
  video.addEventListener('volumechange', () => !video.muted && quiet(), { signal })
}

function unmount(restore: boolean) {
  const current = mounted
  if (!current) return
  mounted = null
  current.stop.abort()
  try {
    current.player.destroy()
  } catch {
    // Already gone with the page.
  }
  current.overlay.remove()
  if (restore && current.twitchVideo?.isConnected) {
    current.twitchVideo.muted = false
    current.twitchVideo.play().catch(() => undefined)
  }
}

function mount(root: HTMLElement, source: Source, key: string) {
  const stop = new AbortController()
  const overlay = document.createElement('div')
  overlay.dataset.regie = 'player'
  overlay.style.cssText = OVERLAY_CSS
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
  root.append(overlay)
  // Clicks and keys on our player must not reach Twitch's own controls underneath.
  for (const type of ['click', 'dblclick', 'keydown', 'pointerdown'] as const)
    overlay.addEventListener(type, (event) => event.stopPropagation(), { signal: stop.signal })

  const volume = savedVolume()
  const player = createVideoPlayer(
    {
      source,
      container: overlay,
      host: location.hostname,
      initialVolume: soundAllowed() ? volume : 0,
      events: {
        state: () => undefined,
        latency: () => undefined,
        userVolume: (value, muted) => {
          if (!muted && value > 0.01) localStorage.setItem(VOLUME_KEY, String(value))
        },
        quality: () => undefined,
      },
    },
    {
      src: relayUrl(EXTENSION_BASE, '', source),
      forceHls: true,
      loadPlaylist,
      // Offline, or nothing playable: Twitch's player takes over again.
      onFail: () =>
        setTimeout(() => {
          if (mounted?.key !== key) return
          failedKey = key
          unmount(true)
        }, 0),
    },
  )
  const twitchVideo = twitchVideoIn(root)
  hush(twitchVideo, stop.signal)
  mounted = { key, root, overlay, player, twitchVideo, stop }
  // The first gesture on the page lets the stream have its sound.
  if (!soundAllowed() && volume > 0) {
    const unmute = () => setTimeout(() => mounted?.player === player && soundAllowed() && player.setVolume(volume), 0)
    window.addEventListener('pointerdown', unmute, { capture: true, once: true, signal: stop.signal })
    window.addEventListener('keydown', unmute, { capture: true, once: true, signal: stop.signal })
  }
}

/**
 * Keeps ours on the page's channel or video. Twitch is a single-page app: it swaps its player around, and
 * keeps it playing in a small corner player while the viewer browses the rest of the site. Ours stays in
 * that small player too, until the viewer closes it or opens another channel.
 */
function sync() {
  const source = pageSource(location.href)
  const key = source ? `${source.kind}:${source.id}` : ''
  const root = document.querySelector<HTMLElement>(PLAYER_ROOT)
  if (mounted) {
    const gone = !mounted.root.isConnected
    const elsewhere = source !== null && (mounted.key !== key || mounted.root !== root)
    if (gone || elsewhere) unmount(false)
  }
  if (mounted) {
    // Twitch may put a new video element in the same player: it stays silent too.
    const current = twitchVideoIn(mounted.root)
    if (current && current !== mounted.twitchVideo) {
      mounted.twitchVideo = current
      hush(current, mounted.stop.signal)
    }
    return
  }
  if (key !== failedKey) failedKey = ''
  if (!source || !root || key === failedKey) return
  mount(root, source, key)
}

// Not on Twitch's embeds or popouts of other pages: only the site's own pages.
if (window.top === window) {
  setInterval(sync, 500)
  sync()
}
