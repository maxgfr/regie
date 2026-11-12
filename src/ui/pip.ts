import type { Store } from '../app/store.ts'
import { t } from '../i18n/index.ts'
import { embedUrl } from '../platforms/embed.ts'
import { capabilities } from '../platforms/parse.ts'

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options: { width: number; height: number }): Promise<Window>
      window: Window | null
    }
  }
}

export const pipSupported = () => typeof window !== 'undefined' && 'documentPictureInPicture' in window

const CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0b0c0d;color:#e6e8e3;font:14px/1.3 'Barlow Condensed','Barlow',system-ui,sans-serif}
  body{display:flex;flex-direction:column}
  iframe,video{flex:1 1 auto;width:100%;min-height:0;border:0;background:#000;display:block}
  nav{flex:none;display:flex;gap:4px;padding:6px;background:#141618;overflow-x:auto}
  button{flex:none;display:flex;align-items:center;gap:6px;max-width:160px;height:28px;padding:0 10px;border:1px solid #000;
    border-radius:4px;background:#1d2023;color:#9aa1a9;font:600 13px 'Barlow Condensed',system-ui,sans-serif;
    letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  button[aria-pressed=true]{background:#ff3b30;color:#fff}
  button b{font-family:'JetBrains Mono',monospace;font-weight:500}
  :focus-visible{outline:2px solid #ffb020;outline-offset:2px}
`

/**
 * The mini control room: an always-on-top window (Document Picture-in-Picture) with the stream on air and
 * keys to switch it, so a match keeps playing while you use other apps. It runs its own player; the wall
 * stays loaded but silent until the window closes.
 */
export async function openMiniRegie(store: Store) {
  const api = window.documentPictureInPicture
  if (!api) {
    store.toast('toast.noPip')
    return
  }
  if (api.window) {
    api.window.focus()
    return
  }
  const pip = await api.requestWindow({ width: 640, height: 400 })
  const doc = pip.document
  doc.title = 'Regie'
  const style = doc.createElement('style')
  style.textContent = CSS
  doc.head.append(style)
  for (const sheet of document.querySelectorAll<HTMLLinkElement>('link[href*="fonts.css"]')) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = sheet.href
    doc.head.append(link)
  }
  let shownId: string | null = null
  let player: HTMLElement | null = null
  const nav = doc.createElement('nav')
  nav.setAttribute('aria-label', t('console.pgm'))

  const show = (id: string | null) => {
    const tile = store.tile(id) ?? store.session.tiles.find((other) => other.source.kind !== 'unembeddable')
    if (!tile || tile.id === shownId) return
    shownId = tile.id
    player?.remove()
    if (tile.source.platform === 'video') {
      const video = doc.createElement('video')
      video.src = tile.source.id
      video.autoplay = true
      video.controls = true
      player = video
    } else {
      const frame = doc.createElement('iframe')
      frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'
      frame.title = store.label(tile.id)
      frame.src =
        embedUrl(tile.source, { host: location.hostname || 'localhost', muted: false, origin: location.origin }) ??
        'about:blank'
      player = frame
    }
    doc.body.prepend(player)
    render()
  }

  const render = () => {
    nav.replaceChildren(
      ...store.session.tiles
        .filter((tile) => tile.source.kind !== 'unembeddable' && capabilities(tile.source))
        .map((tile, index) => {
          const button = doc.createElement('button')
          button.type = 'button'
          button.setAttribute('aria-pressed', String(tile.id === shownId))
          button.title = store.label(tile.id)
          const number = doc.createElement('b')
          number.textContent = String(index + 1)
          button.append(number, store.label(tile.id))
          button.addEventListener('click', () => {
            store.onAir(tile.id)
            show(tile.id)
          })
          return button
        }),
    )
  }

  doc.body.append(nav)
  store.setMiniRegie(true)
  show(store.mix().onAir)
  const onChange = () => {
    if (!store.tile(shownId)) {
      shownId = null
      show(store.mix().onAir)
    } else render()
  }
  store.addEventListener('change', onChange)
  pip.addEventListener('pagehide', () => {
    store.removeEventListener('change', onChange)
    store.setMiniRegie(false)
  })
}
