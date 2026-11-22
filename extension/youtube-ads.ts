/**
 * Runs in YouTube's embedded player (main world, at document_start) when it is inside Regie: takes the ad
 * placements out of the player's data before the player reads them, so it has no ad to play. The same idea as
 * uBlock Origin's `json-prune` scriptlet, written for Regie's embeds only: anywhere else, it does nothing.
 */
import { EXTENSION_ORIGINS } from '../src/core/extension-protocol.ts'
import { pruneAds } from './youtube-prune.ts'

const ancestors = Array.from(location.ancestorOrigins ?? [])

if (ancestors.some((origin) => EXTENSION_ORIGINS.includes(origin))) {
  // Player data parsed by the page's own code (XHR answers, inline JSON).
  const parse = JSON.parse
  JSON.parse = function prunedParse(this: unknown, ...args: Parameters<typeof JSON.parse>) {
    return pruneAds(parse.apply(this, args))
  }
  // Player data read with fetch (`/youtubei/v1/player`).
  const json = Response.prototype.json
  Response.prototype.json = async function prunedJson(this: Response) {
    return pruneAds(await json.call(this))
  }
  // The first answer is inlined in the page as a global.
  let initial: unknown
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (value) => {
        initial = pruneAds(value)
      },
    })
  } catch {
    // Already defined by the page: its first ad may play.
  }
}
