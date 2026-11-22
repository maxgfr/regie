/**
 * Content script on www.twitch.tv (isolated world): plays the channel or video of the page in Regie's own HLS
 * player (`src/players/video.ts`, hls.js), on top of Twitch's player, which is paused and muted underneath.
 * The playlists come from the extension's engine (the relay's, in the service worker): no ads, the quality
 * menu, and silent playback that keeps going in a background tab. When ours can't play (offline channel,
 * error before the first picture), it goes away and Twitch's player plays again.
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
import type { Player, QualityState } from '../src/players/types.ts'
import { createVideoPlayer } from '../src/players/video.ts'
import { pageSource } from './twitch-page.ts'

/** The root of Twitch's player. */
const PLAYER_ROOT = '[data-a-target="video-player"]'
const VOLUME_KEY = 'regie:volume'

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

const OVERLAY_CSS = `
  position:absolute;inset:0;z-index:2147483000;background:#000;
`
const MENU_CSS = `
  position:absolute;top:8px;right:8px;z-index:1;height:26px;padding:0 6px;border:0;border-radius:4px;
  background:rgba(0,0,0,.65);color:#fff;font:600 12px/26px system-ui,sans-serif;cursor:pointer;opacity:0;
  transition:opacity .15s;
`

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

/** Twitch's own video: silent and paused while ours plays; it starts again on its own if Twitch wants to. */
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

function renderMenu(menu: HTMLSelectElement, player: Player, state: QualityState) {
  if (state.levels.length < 2) {
    menu.hidden = true
    return
  }
  menu.hidden = false
  const options = [
    { value: '', label: state.playing ? `Auto · ${state.playing}` : 'Auto' },
    ...state.levels.map((level) => ({ value: level.id, label: level.label })),
  ]
  menu.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      option.selected = (state.selected ?? '') === value
      return option
    }),
  )
  menu.onchange = () => player.setQuality?.(menu.value || null)
}

function mount(root: HTMLElement, source: Source, key: string) {
  const stop = new AbortController()
  const twitchVideo = root.querySelector('video')
  const overlay = document.createElement('div')
  overlay.dataset.regie = 'player'
  overlay.style.cssText = OVERLAY_CSS
  const screen = document.createElement('div')
  screen.style.cssText = 'position:absolute;inset:0'
  const menu = document.createElement('select')
  menu.title = 'Quality'
  menu.style.cssText = MENU_CSS
  menu.hidden = true
  overlay.addEventListener('mouseenter', () => (menu.style.opacity = '1'), { signal: stop.signal })
  overlay.addEventListener('mouseleave', () => (menu.style.opacity = '0'), { signal: stop.signal })
  overlay.append(screen, menu)
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
  root.append(overlay)
  // Clicks and keys on our player must not reach Twitch's own controls underneath.
  for (const type of ['click', 'dblclick', 'keydown'] as const)
    overlay.addEventListener(type, (event) => event.stopPropagation(), { signal: stop.signal })

  const volume = savedVolume()
  let player: Player | null = null
  player = createVideoPlayer(
    {
      source,
      container: screen,
      host: location.hostname,
      initialVolume: soundAllowed() ? volume : 0,
      events: {
        state: () => undefined,
        progress: () => undefined,
        latency: () => undefined,
        adHint: () => undefined,
        userVolume: (value, muted) => {
          if (!muted && value > 0) localStorage.setItem(VOLUME_KEY, String(value))
        },
        quality: (state) => player && renderMenu(menu, player, state),
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
  hush(twitchVideo, stop.signal)
  mounted = { key, root, overlay, player, twitchVideo, stop }
  // The first gesture on the page lets the stream have its sound.
  if (!soundAllowed() && volume > 0) {
    const unmute = () => setTimeout(() => mounted?.player === player && soundAllowed() && player?.setVolume(volume), 0)
    window.addEventListener('pointerdown', unmute, { capture: true, once: true, signal: stop.signal })
    window.addEventListener('keydown', unmute, { capture: true, once: true, signal: stop.signal })
  }
}

/** Keeps ours on the page's channel or video: Twitch is a single-page app that swaps its player around. */
function sync() {
  const source = pageSource(location.href)
  const key = source ? `${source.kind}:${source.id}` : ''
  const root = source ? document.querySelector<HTMLElement>(PLAYER_ROOT) : null
  if (mounted && (mounted.key !== key || !mounted.root.isConnected || mounted.root !== root)) unmount(false)
  if (key !== failedKey) failedKey = ''
  if (!source || !root || mounted || key === failedKey) return
  mount(root, source, key)
}

// Not on Twitch's embeds or popouts of other pages: only the site's own pages.
if (window.top === window) {
  setInterval(sync, 500)
  sync()
}
