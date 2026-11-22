import type { Source } from '../src/core/types.ts'
import { parseSource } from '../src/platforms/parse.ts'

/** Twitch pages whose first path segment isn't a channel. */
const NOT_CHANNELS = new Set([
  '',
  'directory',
  'downloads',
  'drops',
  'friends',
  'inventory',
  'jobs',
  'messages',
  'moderator',
  'p',
  'payments',
  'popout',
  'prime',
  'search',
  'settings',
  'subscriptions',
  'turbo',
  'u',
  'videos',
  'wallet',
])

/**
 * What a twitch.tv page shows that Regie's player can play: a live channel (`/login`) or a video
 * (`/videos/123`). Clips, a channel's other tabs and the rest of the site keep Twitch's player.
 */
export function pageSource(href: string): Source | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const [first = '', second, ...rest] = url.pathname.split('/').filter(Boolean)
  if (first === 'videos' && second && /^\d+$/.test(second) && !rest.length)
    return parseSource(`https://www.twitch.tv/videos/${second}`)
  if (NOT_CHANNELS.has(first.toLowerCase()) || second) return null
  const source = parseSource(`https://www.twitch.tv/${first}`)
  return source?.platform === 'twitch' && source.kind === 'live' ? source : null
}
