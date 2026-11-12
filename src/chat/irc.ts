/**
 * Twitch chat, read-only and anonymous: the public IRC WebSocket accepts `justinfan` nicknames without
 * any account or app. Regie only reads messages; it never sends any.
 */

export interface ChatMessage {
  id: string
  channel: string
  user: string
  color: string
  text: string
  /** Emote ranges from the `emotes` tag: [emote id, start, end] on code points. */
  emotes: [string, number, number][]
  at: number
}

export interface ParsedLine {
  tags: Record<string, string>
  prefix: string
  command: string
  params: string[]
}

export function parseLine(line: string): ParsedLine | null {
  let rest = line
  const tags: Record<string, string> = {}
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=')
      tags[eq < 0 ? pair : pair.slice(0, eq)] = eq < 0 ? '' : unescapeTag(pair.slice(eq + 1))
    }
    rest = rest.slice(space + 1)
  }
  let prefix = ''
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    prefix = rest.slice(1, space)
    rest = rest.slice(space + 1)
  }
  const trailingAt = rest.indexOf(' :')
  let trailing: string | undefined
  if (trailingAt >= 0) {
    trailing = rest.slice(trailingAt + 2)
    rest = rest.slice(0, trailingAt)
  }
  const [command, ...params] = rest.split(' ').filter(Boolean)
  if (!command) return null
  if (trailing !== undefined) params.push(trailing)
  return { tags, prefix, command, params }
}

function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => ({ s: ' ', n: '\n', r: '\r', ':': ';', '\\': '\\' })[c] ?? c)
}

export function parseEmotes(tag: string | undefined): [string, number, number][] {
  if (!tag) return []
  const out: [string, number, number][] = []
  for (const group of tag.split('/')) {
    const [id, ranges] = group.split(':')
    if (!id || !ranges) continue
    for (const range of ranges.split(',')) {
      const [start, end] = range.split('-').map(Number)
      if (Number.isInteger(start) && Number.isInteger(end)) out.push([id, start as number, end as number])
    }
  }
  return out.sort((a, b) => a[1] - b[1])
}

/** Splits a message into text and emote parts. Twitch counts positions in code points, not UTF-16 units. */
export function segments(message: ChatMessage): ({ text: string } | { emote: string; name: string })[] {
  const chars = Array.from(message.text)
  const parts: ({ text: string } | { emote: string; name: string })[] = []
  let cursor = 0
  for (const [id, start, end] of message.emotes) {
    if (start < cursor || end >= chars.length) continue
    if (start > cursor) parts.push({ text: chars.slice(cursor, start).join('') })
    parts.push({ emote: id, name: chars.slice(start, end + 1).join('') })
    cursor = end + 1
  }
  if (cursor < chars.length) parts.push({ text: chars.slice(cursor).join('') })
  return parts
}

export function toMessage(line: ParsedLine, at: number): ChatMessage | null {
  if (line.command !== 'PRIVMSG') return null
  const channel = (line.params[0] ?? '').replace(/^#/, '')
  const text = line.params[1] ?? ''
  const user = line.tags['display-name'] || line.prefix.split('!')[0] || '?'
  // `/me` actions arrive wrapped in CTCP markers (the control character 0x01).
  const marker = String.fromCharCode(1)
  const isAction = text.startsWith(`${marker}ACTION `) && text.endsWith(marker)
  return {
    id: line.tags.id || `${at}-${Math.random().toString(36).slice(2)}`,
    channel,
    user,
    color: line.tags.color || '',
    text: isAction ? text.slice(8, -1) : text,
    emotes: parseEmotes(line.tags.emotes),
    at,
  }
}

export const emoteUrl = (id: string) =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`

export class TwitchChat {
  #socket: WebSocket | null = null
  #channels = new Set<string>()
  #retry = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  onMessage: (message: ChatMessage) => void = () => undefined
  onStatus: (connected: boolean) => void = () => undefined

  setChannels(channels: string[]) {
    const next = new Set(channels.map((channel) => channel.toLowerCase()))
    const socket = this.#socket
    if (socket?.readyState === WebSocket.OPEN) {
      const join = [...next].filter((channel) => !this.#channels.has(channel))
      const part = [...this.#channels].filter((channel) => !next.has(channel))
      if (join.length) socket.send(`JOIN ${join.map((c) => `#${c}`).join(',')}`)
      if (part.length) socket.send(`PART ${part.map((c) => `#${c}`).join(',')}`)
    }
    this.#channels = next
    if (next.size && !this.#socket) this.#connect()
    if (!next.size) this.close(false)
  }

  #connect() {
    this.#closed = false
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    this.#socket = socket
    socket.onopen = () => {
      this.#retry = 0
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      socket.send('PASS SCHMOOPIIE')
      socket.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`)
      if (this.#channels.size) socket.send(`JOIN ${[...this.#channels].map((c) => `#${c}`).join(',')}`)
      this.onStatus(true)
    }
    socket.onmessage = (event) => {
      const now = Date.now()
      for (const raw of String(event.data).split('\r\n')) {
        if (!raw) continue
        if (raw.startsWith('PING')) {
          socket.send(raw.replace('PING', 'PONG'))
          continue
        }
        const line = parseLine(raw)
        const message = line && toMessage(line, now)
        if (message) this.onMessage(message)
      }
    }
    socket.onclose = () => {
      this.#socket = null
      this.onStatus(false)
      if (this.#closed || !this.#channels.size) return
      const wait = Math.min(30_000, 1000 * 2 ** this.#retry++)
      this.#timer = setTimeout(() => this.#connect(), wait)
    }
  }

  close(forget = true) {
    this.#closed = true
    clearTimeout(this.#timer)
    if (forget) this.#channels.clear()
    this.#socket?.close()
    this.#socket = null
  }
}
