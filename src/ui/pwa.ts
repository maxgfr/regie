import type { Store } from '../app/store.ts'
import { parseSource } from '../platforms/parse.ts'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: { targetURL?: string }) => void): void }
  }
}

let deferred: InstallPrompt | null = null

/** Sources in a shared link or text: Android's share sheet sends `?url=`, `?text=` or `?title=`. */
export function sharedSources(url: URL) {
  const values = ['url', 'text', 'title'].map((key) => url.searchParams.get(key) ?? '')
  const words = values
    .join(' ')
    .split(/\s+/)
    .filter((word) => /^https?:\/\//.test(word))
  return words.map(parseSource).filter((source) => source !== null)
}

/** Install prompt, links shared to Regie from other apps, and launches into the open window. */
export function setupPwa(store: Store) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event as InstallPrompt
    store.ui.installable = true
    store.changed(false)
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    store.ui.installable = false
    store.changed(false)
  })

  const receive = (target: string | undefined) => {
    if (!target) return
    const url = new URL(target, location.href)
    const sources = sharedSources(url)
    if (sources.length) store.addMany(sources)
    if (url.searchParams.has('library')) store.openLibrary('search')
  }
  // Shared or launched while Regie is already open: add to the wall in place (launch_handler focus-existing).
  window.launchQueue?.setConsumer((params) => receive(params.targetURL))
  // Opened by a share or a shortcut: read the address once, then clean it so a reload doesn't add it again.
  const current = new URL(location.href)
  if (['url', 'text', 'title', 'library'].some((key) => current.searchParams.has(key))) {
    receive(current.href)
    history.replaceState(null, '', `${location.pathname}${location.hash}`)
  }
}

export async function install(store: Store) {
  if (!deferred) return
  await deferred.prompt()
  await deferred.userChoice.catch(() => undefined)
  deferred = null
  store.ui.installable = false
  store.changed(false)
}
