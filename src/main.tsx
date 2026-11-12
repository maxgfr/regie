import './ui/styles.css'
import { createRoot } from 'remix/component'
import { Store } from './app/store.ts'
import { locale } from './i18n/index.ts'
import { App } from './ui/App.tsx'
import { setupPwa } from './ui/pwa.ts'

document.documentElement.lang = locale

// Files served as they are (fonts, icons, manifest) are linked here rather than in index.html,
// so the bundler doesn't try to bundle them.
for (const [rel, href, type] of [
  ['stylesheet', './fonts/fonts.css', 'text/css'],
  ['icon', './icon.svg', 'image/svg+xml'],
  ['apple-touch-icon', './icon-192.png', ''],
  ['manifest', './manifest.webmanifest', ''],
] as const) {
  if (document.querySelector(`link[rel="${rel}"]`)) continue
  const link = document.createElement('link')
  link.rel = rel
  link.href = href
  if (type) link.type = type
  document.head.append(link)
}

const store = new Store()
store.start()
// Local development and end-to-end tests read the store directly.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  ;(window as unknown as { regie: Store }).regie = store
}

setupPwa(store)

const container = document.getElementById('app')
if (container) createRoot(container).render(<App store={store} />)

// Keep the screen awake while streams play.
let wakeLock: { release(): Promise<void> } | null = null
async function keepAwake() {
  const wanted = store.session.tiles.length > 0 && document.visibilityState === 'visible'
  try {
    if (wanted && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen')
      ;(wakeLock as unknown as EventTarget).addEventListener('release', () => {
        wakeLock = null
      })
    } else if (!wanted && wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
  } catch {
    // Refused (battery saver, no permission): the screen may sleep.
  }
}
store.addEventListener('change', keepAwake)
document.addEventListener('visibilitychange', keepAwake)

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined)
}
