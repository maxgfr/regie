import type { Store } from '../app/store.ts'

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** Shortcuts of the control room. Keys act on the stream under the pointer (the selected one). */
export function installKeyboard(store: Store, input: () => HTMLInputElement | null, signal: AbortSignal) {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        if (store.ui.syncOpen) store.openSync(false)
        else if (store.ui.helpOpen || store.ui.libraryOpen) {
          store.ui.helpOpen = false
          store.ui.libraryOpen = false
          store.changed(false)
        } else if (typing(event.target)) (event.target as HTMLElement).blur()
        return
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          input()?.focus()
        }
        return
      }
      const tiles = store.session.tiles
      const selected = store.ui.selectedId
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
      if (digit) {
        const tile = tiles[Number(digit) - 1]
        if (!tile) return
        event.preventDefault()
        if (store.ui.syncOpen) store.clap(tile.id)
        else if (event.shiftKey) store.setMain(tile.id)
        else store.onAir(tile.id)
        return
      }
      if (event.key === 'Alt') {
        if (!event.repeat && selected) store.listen(selected)
        event.preventDefault()
        return
      }
      if (store.ui.syncOpen && selected) {
        if (event.key === ' ') {
          event.preventDefault()
          store.clap(selected)
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          store.nudge(selected, event.key === 'ArrowRight' ? 0.25 : -0.25)
          return
        }
      }
      switch (event.key.toLowerCase()) {
        case 'l':
          store.cycleLayout()
          break
        case 'c':
          store.toggleChat()
          break
        case 's':
          if (tiles.length > 1) store.openSync(!store.ui.syncOpen)
          break
        case 't':
          store.setTransition(store.session.transition === 'cut' ? 'mix' : 'cut')
          break
        case 'a':
          if (selected) store.toggleAd(selected)
          break
        case 'm':
          if (selected) store.toggleMute(selected)
          break
        case 'f':
          if (selected)
            document
              .querySelector<HTMLElement>(`[data-tile="${selected}"]`)
              ?.requestFullscreen?.()
              .catch(() => undefined)
          break
        case '/':
          event.preventDefault()
          input()?.focus()
          break
        case '?':
          store.ui.helpOpen = !store.ui.helpOpen
          store.ui.libraryOpen = false
          store.changed(false)
          break
        case 'b':
          store.openLibrary()
          break
        default:
          return
      }
    },
    { signal },
  )

  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Alt') store.listen(null)
    },
    { signal },
  )

  // Clicking inside a player gives it the keyboard. Note which stream it was, then take the keyboard back
  // so the shortcuts keep working. Chat frames keep the focus: people type in them.
  window.addEventListener(
    'blur',
    () => {
      setTimeout(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLIFrameElement)) return
        const tile = active.closest<HTMLElement>('[data-tile]')
        if (!tile?.dataset.tile) return
        store.select(tile.dataset.tile)
        setTimeout(() => {
          if (document.activeElement === active) document.getElementById('stage')?.focus({ preventScroll: true })
        }, 150)
      }, 0)
    },
    { signal },
  )
}
