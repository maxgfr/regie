import type { PlatformId } from '../core/types.ts'

/**
 * Finding creators without an account.
 *
 * - Twitch: the public GraphQL endpoint of twitch.tv, with the client id of Twitch's own web player.
 *   It is undocumented and unofficial: it may change or stop working, and the UI says so. It is only
 *   used to search channels and read who is live; never to change anything.
 * - Kick: its public website API (search and channel), which needs no key either.
 * Every function returns `[]`/`null` on failure, so the rest of Regie never depends on them.
 */

export interface Creator {
  platform: Extract<PlatformId, 'twitch' | 'kick'>
  /** Channel name used in URLs and embeds. */
  id: string
  name: string
  avatar?: string
  live: boolean
  title?: string
  category?: string
  viewers?: number
}

const TWITCH_GQL = 'https://gql.twitch.tv/gql'
const TWITCH_WEB_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

interface TwitchUser {
  login: string
  displayName: string
  profileImageURL?: string
  broadcastSettings?: { title?: string; game?: { displayName?: string } | null } | null
  stream?: { viewersCount?: number; title?: string; game?: { displayName?: string } | null } | null
}

async function twitchQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const response = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_WEB_CLIENT, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ query, variables }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) return null
    const json = (await response.json()) as { data?: T; errors?: unknown }
    return json.data ?? null
  } catch {
    return null
  }
}

export function fromTwitchUser(user: TwitchUser): Creator {
  return {
    platform: 'twitch',
    id: user.login.toLowerCase(),
    name: user.displayName || user.login,
    avatar: user.profileImageURL,
    live: Boolean(user.stream),
    title: user.stream?.title ?? user.broadcastSettings?.title ?? undefined,
    category: user.stream?.game?.displayName ?? user.broadcastSettings?.game?.displayName ?? undefined,
    viewers: user.stream?.viewersCount,
  }
}

const USER_FIELDS =
  'login displayName profileImageURL(width:70) broadcastSettings{title game{displayName}} stream{viewersCount title game{displayName}}'

export async function searchTwitch(query: string, signal?: AbortSignal): Promise<Creator[]> {
  const data = await twitchQuery<{ searchFor?: { channels?: { items?: TwitchUser[] } } }>(
    `query($q:String!){searchFor(userQuery:$q,platform:"web"){channels{items{${USER_FIELDS}}}}}`,
    { q: query },
    signal,
  )
  return (data?.searchFor?.channels?.items ?? []).filter((user) => user?.login).map(fromTwitchUser)
}

/** Live status of Twitch channels, by name. Missing channels are left out. */
export async function twitchChannels(logins: string[], signal?: AbortSignal): Promise<Creator[]> {
  if (!logins.length) return []
  const data = await twitchQuery<{ users?: (TwitchUser | null)[] }>(
    `query($l:[String!]){users(logins:$l){${USER_FIELDS}}}`,
    { l: logins.slice(0, 100) },
    signal,
  )
  return (data?.users ?? []).filter((user): user is TwitchUser => Boolean(user?.login)).map(fromTwitchUser)
}

interface KickChannel {
  slug?: string
  user?: { username?: string; profile_pic?: string | null } | null
  livestream?: { session_title?: string; viewer_count?: number; categories?: { name?: string }[] } | null
  is_live?: boolean
  chatroom?: { id?: number } | null
}

export function fromKickChannel(channel: KickChannel): Creator | null {
  if (!channel.slug) return null
  return {
    platform: 'kick',
    id: channel.slug.toLowerCase(),
    name: channel.user?.username || channel.slug,
    avatar: channel.user?.profile_pic ?? undefined,
    live: Boolean(channel.livestream ?? channel.is_live),
    title: channel.livestream?.session_title,
    category: channel.livestream?.categories?.[0]?.name,
    viewers: channel.livestream?.viewer_count,
  }
}

async function kickJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
    return response.ok ? ((await response.json()) as T) : null
  } catch {
    return null
  }
}

export async function searchKick(query: string, signal?: AbortSignal): Promise<Creator[]> {
  const data = await kickJson<{ channels?: KickChannel[] }>(
    `https://kick.com/api/search?searched_word=${encodeURIComponent(query)}`,
    signal,
  )
  return (data?.channels ?? []).map(fromKickChannel).filter((creator): creator is Creator => creator !== null)
}

export async function kickChannel(
  slug: string,
  signal?: AbortSignal,
): Promise<(Creator & { chatroom?: number }) | null> {
  const data = await kickJson<KickChannel>(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, signal)
  const creator = data && fromKickChannel(data)
  return creator ? { ...creator, chatroom: data?.chatroom?.id } : null
}

/** Searches both platforms at once; live channels first, then by audience. */
export async function searchCreators(query: string, signal?: AbortSignal): Promise<Creator[]> {
  const [twitch, kick] = await Promise.all([searchTwitch(query, signal), searchKick(query, signal)])
  return [...twitch, ...kick].sort((a, b) => Number(b.live) - Number(a.live) || (b.viewers ?? 0) - (a.viewers ?? 0))
}
