import { describe, expect, test } from 'bun:test'
import { capabilities } from '../platforms/parse.ts'
import { healthUrl, normalizeRelayBase, parseHealth, relayable, relayUrl } from './relay.ts'

describe('relay', () => {
  test('only Twitch, YouTube and Kick go through the relay', () => {
    expect(relayable({ platform: 'twitch', kind: 'live', id: 'shroud' })).toBe(true)
    expect(relayable({ platform: 'twitch', kind: 'vod', id: '123' })).toBe(true)
    expect(relayable({ platform: 'twitch', kind: 'clip', id: 'Funny' })).toBe(false)
    expect(relayable({ platform: 'youtube', kind: 'live', id: 'UCxxxxxxxxxxxxxxxxxxxxxx' })).toBe(true)
    expect(relayable({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' })).toBe(true)
    expect(relayable({ platform: 'kick', kind: 'live', id: 'xqc' })).toBe(true)
    expect(relayable({ platform: 'vimeo', kind: 'vod', id: '1' })).toBe(false)
    expect(relayable({ platform: 'video', kind: 'live', id: 'https://example.com/a.m3u8' })).toBe(false)
    expect(relayable({ platform: 'tiktok', kind: 'unembeddable', id: 'https://tiktok.com/@a/live' })).toBe(false)
  })

  test('YouTube videos need a relay that can remux them', () => {
    expect(relayable({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }, false)).toBe(false)
    expect(relayable({ platform: 'youtube', kind: 'live', id: 'dQw4w9WgXcQ' }, false)).toBe(true)
  })

  test('the typed address is cleaned', () => {
    expect(normalizeRelayBase('')).toBe('')
    expect(normalizeRelayBase('  ')).toBe('')
    expect(normalizeRelayBase('localhost:7878')).toBe('http://localhost:7878')
    expect(normalizeRelayBase('http://localhost:7878/')).toBe('http://localhost:7878')
    expect(normalizeRelayBase('https://relay.example.com/regie/?x=1#y')).toBe('https://relay.example.com/regie')
    expect(normalizeRelayBase('ftp://example.com')).toBeNull()
    expect(normalizeRelayBase('http://user:pw@example.com')).toBeNull()
    expect(normalizeRelayBase('http://exa mple.com')).toBeNull()
  })

  test('playlist and health addresses carry the source and the key', () => {
    const source = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    expect(relayUrl('http://localhost:7878/', '', source)).toBe(
      'http://localhost:7878/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud',
    )
    expect(relayUrl('http://localhost:7878', 'a b&c', source)).toBe(
      'http://localhost:7878/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud&key=a%20b%26c',
    )
    expect(healthUrl('http://localhost:7878/', '')).toBe('http://localhost:7878/health')
    expect(healthUrl('http://localhost:7878', 'k')).toBe('http://localhost:7878/health?key=k')
  })

  test('a health answer is read defensively', () => {
    expect(parseHealth({ ok: true, version: 1, ytdlp: '2026.10.26', ffmpeg: '7.1' })).toEqual({
      ytdlp: '2026.10.26',
      ffmpeg: '7.1',
    })
    expect(parseHealth({ ok: true, ytdlp: null })).toEqual({ ytdlp: null, ffmpeg: null })
    expect(parseHealth({ ok: false })).toBeNull()
    expect(parseHealth('ok')).toBeNull()
    expect(parseHealth(null)).toBeNull()
  })

  test('a relayed stream gets full sound and seek, and keeps its chat', () => {
    const live = { platform: 'kick' as const, kind: 'live' as const, id: 'xqc' }
    expect(capabilities(live)).toMatchObject({ volume: false, seek: false, latency: false, chat: true })
    expect(capabilities(live, true)).toMatchObject({ volume: true, mute: true, seek: true, latency: true, chat: true })
    const twitch = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    expect(capabilities(twitch, true)).toMatchObject({ seek: true, liveChat: true })
    expect(capabilities({ platform: 'twitch', kind: 'vod', id: '1' }, true).latency).toBe(false)
  })
})
