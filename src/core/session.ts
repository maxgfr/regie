import type { AudioMode, LayoutMode, Session, Source, Tile } from './types.ts'

/**
 * The whole setup lives in the URL hash, so a multiview is shared by copying the address:
 * `#s=tw.shroud,yt.dQw4w9WgXcQ,kk.xqc&l=focus&f=0&a=1&m=solo`.
 */

const CODES: [string, Source['platform'], Source['kind']][] = [
  ['tw', 'twitch', 'live'],
  ['twv', 'twitch', 'vod'],
  ['twc', 'twitch', 'clip'],
  ['yt', 'youtube', 'vod'],
  ['ytl', 'youtube', 'live'],
  ['kk', 'kick', 'live'],
  ['tt', 'tiktok', 'post'],
  ['ttl', 'tiktok', 'unembeddable'],
  ['vm', 'vimeo', 'vod'],
  ['vml', 'vimeo', 'live'],
  ['dm', 'dailymotion', 'vod'],
  ['v', 'video', 'vod'],
  ['vl', 'video', 'live'],
  ['w', 'iframe', 'live'],
]

const LAYOUTS: LayoutMode[] = ['grid', 'focus', 'theater']
const AUDIO_MODES: AudioMode[] = ['solo', 'mix', 'manual']

export function defaultSession(): Session {
  return {
    tiles: [],
    layout: 'grid',
    focusId: null,
    audioId: null,
    audioMode: 'solo',
    duck: 0.2,
    master: 1,
    chatOpen: false,
    liveChat: false,
    antiSpoiler: true,
    transition: 'cut',
    keywords: [],
    autoDirector: false,
    adSwitch: true,
  }
}

export function encodeSource(source: Source): string {
  const code = CODES.find(([, platform, kind]) => platform === source.platform && kind === source.kind)?.[0] ?? 'w'
  return `${code}.${source.id}${source.start ? `@${Math.floor(source.start)}` : ''}`
}

export function decodeSource(text: string): Source | null {
  const dot = text.indexOf('.')
  if (dot < 1) return null
  const code = text.slice(0, dot)
  let rest = text.slice(dot + 1)
  const entry = CODES.find(([c]) => c === code)
  if (!entry || !rest) return null
  const [, platform, kind] = entry
  let start: number | undefined
  const at = rest.lastIndexOf('@')
  // URLs may contain `@` (TikTok handles), so only a trailing `@<digits>` is a start time.
  if (at > 0 && /^\d+$/.test(rest.slice(at + 1))) {
    start = Number(rest.slice(at + 1)) || undefined
    rest = rest.slice(0, at)
  }
  if ((platform === 'video' || platform === 'iframe' || kind === 'unembeddable') && !/^https:\/\//.test(rest)) {
    return null
  }
  return start ? { platform, kind, id: rest, start } : { platform, kind, id: rest }
}

const num = (value: string | null, fallback: number, min: number, max: number) => {
  const parsed = value === null ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

/** A tile's own settings: `~v0.8` volume, `~m` muted, `~d4.2` delay, `~a1.5` lead. */
function encodeTile(tile: Tile): string {
  let flags = ''
  if (tile.volume !== 1) flags += `~v${round(tile.volume)}`
  if (tile.muted) flags += '~m'
  if (tile.delay) flags += `~d${round(tile.delay)}`
  if (tile.ahead) flags += `~a${round(tile.ahead)}`
  return encodeSource(tile.source) + flags
}

const round = (value: number) => Math.round(value * 100) / 100

export function encodeSession(session: Session): string {
  const params = new URLSearchParams()
  if (session.tiles.length) params.set('s', session.tiles.map(encodeTile).join('|'))
  const index = (id: string | null) => session.tiles.findIndex((tile) => tile.id === id)
  if (session.layout !== 'grid') params.set('l', session.layout)
  if (index(session.focusId) > 0) params.set('f', String(index(session.focusId)))
  if (index(session.audioId) > 0) params.set('a', String(index(session.audioId)))
  if (session.audioMode !== 'solo') params.set('m', session.audioMode)
  if (session.duck !== 0.2) params.set('d', String(round(session.duck)))
  if (session.master !== 1) params.set('v', String(round(session.master)))
  if (session.chatOpen) params.set('c', '1')
  if (session.liveChat) params.set('lc', '1')
  if (!session.antiSpoiler) params.set('sp', '0')
  if (session.transition === 'mix') params.set('x', 'mix')
  if (session.keywords.length) params.set('k', session.keywords.join(','))
  if (session.autoDirector) params.set('ad', '1')
  if (!session.adSwitch) params.set('as', '0')
  return params.toString()
}

let nextId = 0
export function newTileId(): string {
  nextId += 1
  return `t${Date.now().toString(36)}${nextId}`
}

export function newTile(source: Source): Tile {
  return { id: newTileId(), source, volume: 1, muted: false, delay: 0, ahead: 0 }
}

/** Reads a session from the URL hash. Settings the link doesn't carry come from `base` (saved preferences). */
export function decodeSession(hash: string, base: Session = defaultSession()): Session {
  const session: Session = { ...base, tiles: [], keywords: [...base.keywords] }
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  for (const part of (params.get('s') ?? '').split('|').filter(Boolean).slice(0, 16)) {
    const [head, ...flags] = part.split('~')
    const source = decodeSource(head ?? '')
    if (!source) continue
    const tile = newTile(source)
    for (const flag of flags) {
      const value = Number(flag.slice(1))
      if (flag === 'm') tile.muted = true
      else if (flag[0] === 'v' && Number.isFinite(value)) tile.volume = Math.min(1, Math.max(0, value))
      else if (flag[0] === 'd' && Number.isFinite(value)) tile.delay = Math.min(600, Math.max(0, value))
      else if (flag[0] === 'a' && Number.isFinite(value)) tile.ahead = Math.min(600, Math.max(-600, value))
    }
    session.tiles.push(tile)
  }
  const pick = (key: string) => session.tiles[num(params.get(key), 0, 0, 99)]?.id ?? session.tiles[0]?.id ?? null
  session.focusId = pick('f')
  session.audioId = pick('a')
  const layout = params.get('l') as LayoutMode
  if (LAYOUTS.includes(layout)) session.layout = layout
  const mode = params.get('m') as AudioMode
  if (AUDIO_MODES.includes(mode)) session.audioMode = mode
  session.duck = num(params.get('d'), base.duck, 0, 1)
  session.master = num(params.get('v'), base.master, 0, 1)
  const flag = (key: string, on: string, current: boolean) => (params.has(key) ? params.get(key) === on : current)
  session.chatOpen = flag('c', '1', base.chatOpen)
  session.liveChat = flag('lc', '1', base.liveChat)
  session.antiSpoiler = flag('sp', '1', base.antiSpoiler)
  session.autoDirector = flag('ad', '1', base.autoDirector)
  session.adSwitch = flag('as', '1', base.adSwitch)
  const transition = params.get('x')
  if (transition === 'mix' || transition === 'cut') session.transition = transition
  if (params.has('k')) {
    session.keywords = (params.get('k') ?? '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 20)
  }
  return session
}
