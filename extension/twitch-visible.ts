/**
 * Runs in Twitch's player (main world) when it is embedded in Regie: the page always looks visible and
 * focused, so a fallback embed keeps playing (and its ad keeps running to its end) in a background tab.
 * Anywhere else, it does nothing.
 */
import { EXTENSION_ORIGINS } from '../src/core/extension-protocol.ts'

const ancestors = Array.from(location.ancestorOrigins ?? [])

if (ancestors.some((origin) => EXTENSION_ORIGINS.includes(origin))) {
  const getters: Record<string, () => unknown> = {
    hidden: () => false,
    webkitHidden: () => false,
    visibilityState: () => 'visible',
    webkitVisibilityState: () => 'visible',
  }
  for (const [name, get] of Object.entries(getters)) {
    for (const target of [Document.prototype, document]) {
      try {
        Object.defineProperty(target, name, { configurable: true, get })
      } catch {}
    }
  }
  const hasFocus = () => true
  Document.prototype.hasFocus = hasFocus
  document.hasFocus = hasFocus
  const stop = (event: Event) => event.stopImmediatePropagation()
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(type, stop, true)
    document.addEventListener(type, stop, true)
  }
}
