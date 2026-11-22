/**
 * Regie's own controls for a `<video>` it plays (`players/video.ts`): in Regie's tiles and, through the
 * extension, on twitch.tv. The browser's native controls have no quality menu and no way back to live.
 * Plain DOM (no Remix) so the extension's content script can use it too; one stylesheet per document. The bar
 * folds on narrow players (container queries) and hides while the picture plays untouched.
 */
import { type IconNode, Maximize, Minimize, Pause, PictureInPicture2, Play, Volume2, VolumeX } from 'lucide'
import { seconds, t } from '../i18n/index.ts'
import type { QualityState } from './types.ts'

export interface ControlsActions {
  /** A live stream: the bar shows LIVE, the latency, and a way back to the live edge. */
  live: boolean
  setQuality(id: string | null): void
  /** Seconds behind the live edge hls.js plays at, or null when unknown. */
  behind(): number | null
  goLive(): void
}

export interface Controls {
  quality(state: QualityState): void
  latency(seconds: number): void
  destroy(): void
}

/** Behind the live edge by more than this, LIVE turns into a "go live" key. */
const BEHIND_S = 6
const HIDE_AFTER_MS = 2500
const STYLE_ID = 'regie-controls-style'

const CSS = `
.regie-controls{position:absolute;inset:auto 0 0 0;z-index:2;display:flex;align-items:center;gap:2px;
  padding:18px 6px 4px;container-type:inline-size;
  background:linear-gradient(transparent,rgba(0,0,0,.78));color:var(--text,#e6e8e3);
  font:500 12px/1 var(--font-ui,'Barlow',system-ui,sans-serif);transition:opacity .18s ease-out;opacity:1}
.regie-controls[data-hidden="true"]{opacity:0;pointer-events:none}
.regie-controls button,.regie-controls select{display:grid;place-items:center;flex:none;height:28px;min-width:28px;
  padding:0 6px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.regie-controls button:hover,.regie-controls select:hover{background:rgba(255,255,255,.12)}
.regie-controls :focus-visible{outline:2px solid var(--amber,#ffb020);outline-offset:2px}
.regie-controls .volume{width:72px;accent-color:var(--text,#e6e8e3);cursor:pointer}
.regie-controls .live{display:flex;gap:6px;align-items:center;font:600 12px/1 var(--font-display,'Barlow Condensed',system-ui,sans-serif);
  letter-spacing:.06em;text-transform:uppercase}
.regie-controls .live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--pgm,#ff3b30)}
.regie-controls .live[data-behind="true"]{color:var(--amber,#ffb020)}
.regie-controls .live[data-behind="true"]::before{background:var(--amber,#ffb020)}
.regie-controls .latency{font:400 12px/1 var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  font-variant-numeric:tabular-nums;color:var(--dim,#9097a0);padding:0 4px;white-space:nowrap}
.regie-controls [hidden]{display:none}
.regie-controls .spacer{flex:1 1 auto}
.regie-controls select{font:400 12px/1 var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  font-variant-numeric:tabular-nums;max-width:116px;appearance:auto}
.regie-controls select option{background:#141618;color:#e6e8e3}
@container (max-width:380px){.regie-controls .volume,.regie-controls .latency{display:none}}
@container (max-width:260px){.regie-controls .pip,.regie-controls .live span{display:none}}
`

function icon(node: IconNode): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  for (const [name, value] of Object.entries({
    width: '18',
    height: '18',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(name, value)
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(ns, tag)
    for (const [name, value] of Object.entries(attrs)) if (value !== undefined) child.setAttribute(name, String(value))
    svg.append(child)
  }
  return svg
}

function button(className: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  return element
}

function setKey(element: HTMLButtonElement, node: IconNode, label: string) {
  element.replaceChildren(icon(node))
  element.title = label
  element.setAttribute('aria-label', label)
}

/** Below this the video is silent for the viewer (Regie's own silence plays at -80 dB, not at 0). */
const AUDIBLE = 0.01

export function createControls(container: HTMLElement, video: HTMLVideoElement, actions: ControlsActions): Controls {
  const doc = container.ownerDocument
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    doc.head.append(style)
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
  const stop = new AbortController()
  const { signal } = stop

  const bar = doc.createElement('div')
  bar.className = 'regie-controls'
  const play = button('play')
  const mute = button('mute')
  const volume = doc.createElement('input')
  volume.type = 'range'
  volume.className = 'volume'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.setAttribute('aria-label', t('player.volume'))
  const live = button('live')
  const liveText = doc.createElement('span')
  liveText.textContent = t('player.live')
  live.append(liveText)
  const latency = doc.createElement('span')
  latency.className = 'latency'
  const spacer = doc.createElement('span')
  spacer.className = 'spacer'
  const quality = doc.createElement('select')
  quality.title = t('tile.quality')
  quality.setAttribute('aria-label', t('tile.quality'))
  quality.hidden = true
  const pip = button('pip')
  setKey(pip, PictureInPicture2, t('player.pip'))
  pip.hidden = !doc.pictureInPictureEnabled
  const full = button('full')
  bar.append(play, mute, volume, ...(actions.live ? [live, latency] : []), spacer, quality, pip, full)
  container.append(bar)

  /** The sound to give back when unmuting a video Regie (or the viewer) silenced. */
  let lastLevel = video.volume >= AUDIBLE ? video.volume : 1

  const silent = () => video.muted || video.volume < AUDIBLE
  const render = () => {
    setKey(play, video.paused ? Play : Pause, video.paused ? t('player.play') : t('player.pause'))
    setKey(mute, silent() ? VolumeX : Volume2, silent() ? t('player.unmute') : t('player.mute'))
    volume.value = String(silent() ? 0 : video.volume)
    const fullscreen = doc.fullscreenElement === container
    setKey(full, fullscreen ? Minimize : Maximize, fullscreen ? t('player.exitFullscreen') : t('player.fullscreen'))
    if (actions.live) {
      const behind = actions.behind()
      const late = behind !== null && behind > BEHIND_S
      live.dataset.behind = String(late)
      live.title = late ? t('player.goLive') : t('player.live')
      live.setAttribute('aria-label', live.title)
    }
  }

  /**
   * A key acts on the press itself, not on the click: the page may move under the pointer before it is
   * released (the first click in Regie removes its "click to enable the sound" notice, and the wall moves up),
   * and a click released elsewhere never fires. The keyboard (Enter, Space) still comes through `click`.
   */
  const press = (element: HTMLElement, action: () => void) => {
    element.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        action()
      },
      { signal },
    )
    element.addEventListener('click', (event) => event.detail === 0 && action(), { signal })
  }

  const togglePlay = () => (video.paused ? video.play().catch(() => undefined) : video.pause())
  press(play, togglePlay)
  press(mute, () => {
    if (silent()) {
      video.muted = false
      video.volume = lastLevel
    } else {
      lastLevel = video.volume
      video.muted = true
    }
  })
  volume.addEventListener(
    'input',
    () => {
      const level = Number(volume.value)
      video.muted = level <= 0
      if (level > 0) {
        video.volume = level
        lastLevel = level
      }
    },
    { signal },
  )
  press(live, () => actions.goLive())
  quality.addEventListener('change', () => actions.setQuality(quality.value || null), { signal })
  press(pip, () => {
    if (doc.pictureInPictureElement === video) doc.exitPictureInPicture().catch(() => undefined)
    else video.requestPictureInPicture().catch(() => undefined)
  })
  const toggleFullscreen = () => {
    if (doc.fullscreenElement === container) doc.exitFullscreen().catch(() => undefined)
    else container.requestFullscreen?.().catch(() => undefined)
  }
  press(full, toggleFullscreen)
  // On the picture itself: a click plays or pauses, a double click goes full screen, as in most players.
  video.addEventListener('click', togglePlay, { signal })
  video.addEventListener('dblclick', toggleFullscreen, { signal })
  for (const type of ['play', 'pause', 'volumechange'] as const) video.addEventListener(type, render, { signal })
  doc.addEventListener('fullscreenchange', render, { signal })
  container.addEventListener(
    'keydown',
    (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      const key = event.key.toLowerCase()
      if (key === ' ' || key === 'k') play.click()
      else if (key === 'm') mute.click()
      else if (key === 'f') toggleFullscreen()
      else return
      event.preventDefault()
      event.stopPropagation()
    },
    { signal },
  )

  // Shown while the pointer moves over the player, the focus is in the bar, or the video is paused.
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const show = () => {
    bar.dataset.hidden = 'false'
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!video.paused && !bar.contains(doc.activeElement)) bar.dataset.hidden = 'true'
    }, HIDE_AFTER_MS)
  }
  container.addEventListener('pointermove', show, { signal })
  container.addEventListener('focusin', show, { signal })
  container.addEventListener(
    'pointerleave',
    () => {
      if (!video.paused) bar.dataset.hidden = 'true'
    },
    { signal },
  )
  const tick = setInterval(render, 1000)
  render()
  show()

  return {
    quality(state) {
      quality.hidden = state.levels.length < 2
      if (quality.hidden) return
      const options = [
        {
          value: '',
          label: state.playing ? t('tile.qualityAutoAt', { q: state.playing }) : t('tile.qualityAuto'),
        },
        ...state.levels.map((level) => ({ value: level.id, label: level.label })),
      ]
      quality.replaceChildren(
        ...options.map(({ value, label }) => {
          const option = doc.createElement('option')
          option.value = value
          option.textContent = label
          option.selected = (state.selected ?? '') === value
          return option
        }),
      )
    },
    latency(value) {
      latency.textContent = seconds(value).replace('+', '')
    },
    destroy() {
      stop.abort()
      clearInterval(tick)
      clearTimeout(hideTimer)
      bar.remove()
    },
  }
}
