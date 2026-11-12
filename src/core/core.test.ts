import { describe, expect, test } from 'bun:test'
import {
  AD_CONFIRM_MS,
  adblockSuspect,
  adReducer,
  adTick,
  BLOCKED_AFTER_MS,
  initialAdState,
  noteAd,
  PREROLL_MS,
  RELOAD_FAILED_MS,
  RELOAD_GAP_MS,
  STALL_MS,
  shouldReload,
} from './ads.ts'
import { mixAudio, standIn } from './audio.ts'
import { decayHype, initialHype, recordMessage, spike } from './hype.ts'
import { decodeSession, defaultSession, encodeSession, newTile } from './session.ts'
import { chatHold, planSync } from './sync.ts'

const tile = (id: string, extra: Partial<{ volume: number; muted: boolean; inAd: boolean; hype: number }> = {}) => ({
  id,
  volume: 1,
  muted: false,
  inAd: false,
  hype: 0,
  ...extra,
})

describe('mixAudio', () => {
  const base = { mode: 'solo' as const, listenId: null, duck: 0.2, master: 1, adSwitch: true }

  test('solo: only the tile on air is audible', () => {
    const out = mixAudio({ ...base, tiles: [tile('a'), tile('b')], audioId: 'b' })
    expect(out).toEqual({ onAir: 'b', covering: false, volumes: { a: 0, b: 1 } })
  })

  test('mix: the others are ducked, the master scales everything', () => {
    const out = mixAudio({ ...base, mode: 'mix', master: 0.5, tiles: [tile('a'), tile('b')], audioId: 'a' })
    expect(out.volumes).toEqual({ a: 0.5, b: 0.1 })
  })

  test('listening to a tile wins over the one on air', () => {
    const out = mixAudio({ ...base, tiles: [tile('a'), tile('b')], audioId: 'a', listenId: 'b' })
    expect(out.onAir).toBe('b')
  })

  test('an ad on the tile on air hands the sound to another one', () => {
    const out = mixAudio({ ...base, tiles: [tile('a', { inAd: true }), tile('b'), tile('c')], audioId: 'a' })
    expect(out).toEqual({ onAir: 'b', covering: true, volumes: { a: 0, b: 1, c: 0 } })
  })

  test('the stand-in is the hottest chat when there is one', () => {
    expect(standIn([tile('a', { inAd: true }), tile('b'), tile('c', { hype: 3 })], 'a')).toBe('c')
  })

  test('no switch when the option is off, or when everyone is in an ad', () => {
    const tiles = [tile('a', { inAd: true }), tile('b')]
    expect(mixAudio({ ...base, adSwitch: false, tiles, audioId: 'a' }).onAir).toBe('a')
    const all = [tile('a', { inAd: true }), tile('b', { inAd: true })]
    expect(mixAudio({ ...base, tiles: all, audioId: 'a' }).onAir).toBe('a')
  })

  test('manual: each fader counts, muted tiles stay silent', () => {
    const tiles = [tile('a', { volume: 0.3 }), tile('b', { volume: 0.7, muted: true })]
    expect(mixAudio({ ...base, mode: 'manual', tiles, audioId: 'a' }).volumes).toEqual({ a: 0.3, b: 0 })
  })
})

describe('planSync', () => {
  test('seekable streams are delayed to the slowest one, live Twitch keeps its lead', () => {
    const plan = planSync([
      { id: 'twitch', mark: 1000, canDelay: false, delay: 0 },
      { id: 'yt', mark: 3000, canDelay: true, delay: 0 },
      { id: 'vod', mark: 5000, canDelay: true, delay: 0 },
    ])
    expect(plan.delays).toEqual({ twitch: 0, yt: 2, vod: 0 })
    expect(plan.ahead).toEqual({ twitch: 4, yt: 0, vod: 0 })
  })

  test('a delay already applied is accounted for', () => {
    const plan = planSync([
      { id: 'a', mark: 4000, canDelay: true, delay: 2 },
      { id: 'b', mark: 3000, canDelay: false, delay: 0 },
    ])
    // a would show it at 2 s without the delay, b at 3 s: a only needs 1 s.
    expect(plan.delays.a).toBe(1)
    expect(plan.ahead.b).toBe(0)
  })

  test('needs at least two marks', () => {
    const plan = planSync([
      { id: 'a', mark: 1000, canDelay: true, delay: 3 },
      { id: 'b', canDelay: true, delay: 0 },
    ])
    expect(plan.delays).toEqual({ a: 3, b: 0 })
  })

  test('chat is held back by latency, delay and lead', () => {
    expect(chatHold(3, 2, 1.5)).toBe(6.5)
    expect(chatHold(undefined, 0, 0)).toBe(0)
  })
})

describe('ads', () => {
  test('a frozen clock while playing reads as an ad, moving again ends it', () => {
    let state = initialAdState(0)
    state = adReducer(state, { type: 'progress', time: 10 }, 0)
    state = adTick(state, STALL_MS + 1, true)
    expect(state.inAd).toBe(true)
    state = adReducer(state, { type: 'progress', time: 10 }, STALL_MS + 500)
    expect(state.inAd).toBe(true)
    state = adReducer(state, { type: 'progress', time: 12 }, STALL_MS + 1000)
    expect(state.inAd).toBe(false)
  })

  test('a pause by the user is not an ad, a pause by the player is', () => {
    expect(adReducer(initialAdState(0), { type: 'paused', byUser: true }, 1).inAd).toBe(false)
    expect(adReducer(initialAdState(0), { type: 'paused', byUser: false }, 1).inAd).toBe(true)
  })

  test('a pause does not end an ad the player reported', () => {
    let state = adReducer(initialAdState(0), { type: 'hint', on: true }, 0)
    state = adReducer(state, { type: 'paused', byUser: true }, 10)
    expect(state.inAd).toBe(true)
    expect(adReducer(state, { type: 'hint', on: false }, 20).inAd).toBe(false)
  })

  test('only a mid-roll is reloaded, at most once in five minutes', () => {
    const late = PREROLL_MS + AD_CONFIRM_MS
    // A pre-roll: the player never showed the stream, or only for a few seconds.
    expect(shouldReload({}, undefined, late)).toBe(false)
    expect(shouldReload({}, 0, 5000)).toBe(false)
    expect(shouldReload({}, 0, late)).toBe(true)
    expect(shouldReload({ at: late }, 0, late + 1000)).toBe(false)
    expect(shouldReload({ at: late }, 0, late + RELOAD_GAP_MS)).toBe(true)
  })

  test('a reload that opens on another ad stops the reloads for a while', () => {
    // The fresh player went straight to an ad, before showing the stream.
    const failed = noteAd({ at: 1000 }, false, 5000)
    expect(failed.failedAt).toBe(5000)
    expect(shouldReload(failed, 0, 1000 + RELOAD_GAP_MS)).toBe(false)
    expect(shouldReload(failed, 0, 5000 + RELOAD_FAILED_MS)).toBe(true)
    // The stream came back first: the reload worked, nothing to remember.
    expect(noteAd({ at: 1000 }, true, 60_000).failedAt).toBeUndefined()
    expect(noteAd({}, false, 5000).failedAt).toBeUndefined()
  })

  test('an ad the player reported holds past the timeout, until the player ends it', () => {
    const state = adReducer(initialAdState(0), { type: 'hint', on: true }, 0)
    expect(adTick(state, 200_000, true).inAd).toBe(true)
    expect(adReducer(state, { type: 'hint', on: false }, 200_000).inAd).toBe(false)
  })

  test('a manual mark holds until removed or timed out', () => {
    let state = adReducer(initialAdState(0), { type: 'manual', on: true }, 0)
    state = adReducer(state, { type: 'progress', time: 5 }, 100)
    expect(state.inAd).toBe(true)
    expect(adTick(state, 200_000, true).inAd).toBe(false)
  })

  test('a player that was asked to play and still never started is suspected of being ad-blocked', () => {
    expect(adblockSuspect({ since: 0, retried: true }, BLOCKED_AFTER_MS + 1)).toBe(true)
    // Not yet: no play() retry sent, or still playing, or offline, or too soon.
    expect(adblockSuspect({ since: 0, retried: false }, BLOCKED_AFTER_MS + 1)).toBe(false)
    expect(adblockSuspect({ since: 0, played: true, retried: true }, BLOCKED_AFTER_MS + 1)).toBe(false)
    expect(adblockSuspect({ since: 0, retried: true, offline: true }, BLOCKED_AFTER_MS + 1)).toBe(false)
    expect(adblockSuspect({ since: 0, retried: true }, BLOCKED_AFTER_MS)).toBe(false)
    expect(adblockSuspect({}, BLOCKED_AFTER_MS + 1)).toBe(false)
  })
})

describe('hype', () => {
  test('a burst over a calm baseline spikes, a steady big chat does not', () => {
    let calm = initialHype(0)
    for (let t = 0; t < 300_000; t += 2000) calm = decayHype(recordMessage(calm, t), t)
    const now = 300_000
    for (let i = 0; i < 40; i++) calm = recordMessage(calm, now + i * 100)
    expect(spike(calm, now + 4000)).toBeGreaterThan(2.5)

    let busy = initialHype(0)
    for (let t = 0; t < 300_000; t += 100) busy = recordMessage(busy, t)
    busy = decayHype(busy, 300_000)
    expect(spike(busy, 300_000)).toBeLessThan(1.5)
  })
})

describe('session', () => {
  test('round trip through the URL hash', () => {
    const session = defaultSession()
    const a = newTile({ platform: 'twitch', kind: 'live', id: 'shroud' })
    const b = {
      ...newTile({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ', start: 42 }),
      volume: 0.5,
      delay: 2.5,
    }
    const c = { ...newTile({ platform: 'video', kind: 'live', id: 'https://example.com/a@b/live.m3u8' }), muted: true }
    Object.assign(session, {
      tiles: [a, b, c],
      layout: 'focus',
      focusId: b.id,
      audioId: c.id,
      audioMode: 'mix',
      duck: 0.35,
      liveChat: true,
      keywords: ['ace', 'clutch'],
      adSwitch: false,
    })
    const decoded = decodeSession(`#${encodeSession(session)}`)
    expect(decoded.tiles.map((t) => t.source)).toEqual([a.source, b.source, c.source])
    expect(decoded.tiles[1]).toMatchObject({ volume: 0.5, delay: 2.5 })
    expect(decoded.tiles[2]?.muted).toBe(true)
    expect(decoded.focusId).toBe(decoded.tiles[1]?.id ?? '')
    expect(decoded.audioId).toBe(decoded.tiles[2]?.id ?? '')
    expect(decoded).toMatchObject({ layout: 'focus', audioMode: 'mix', duck: 0.35, liveChat: true, adSwitch: false })
    expect(decoded.keywords).toEqual(['ace', 'clutch'])
  })

  test('settings the link does not carry come from the saved preferences', () => {
    const base = { ...defaultSession(), liveChat: true, audioMode: 'mix' as const, keywords: ['gg'] }
    const decoded = decodeSession('#s=tw.a', base)
    expect(decoded).toMatchObject({ liveChat: true, audioMode: 'mix', keywords: ['gg'] })
    expect(decodeSession('#s=tw.a&lc=0&m=solo&k=', base)).toMatchObject({
      liveChat: false,
      audioMode: 'solo',
      keywords: [],
    })
  })

  test('links are easy to write by hand: bare Twitch channels joined with +', () => {
    const twitch = (id: string) => ({ platform: 'twitch' as const, kind: 'live' as const, id })
    expect(decodeSession('#giuseppemdr+slash_ftv').tiles.map((t) => t.source)).toEqual([
      twitch('giuseppemdr'),
      twitch('slash_ftv'),
    ])
    const mixed = decodeSession('#shroud+yt.dQw4w9WgXcQ+kk.xqc&l=focus&a=2')
    expect(mixed.tiles.map((t) => `${t.source.platform}:${t.source.id}`)).toEqual([
      'twitch:shroud',
      'youtube:dQw4w9WgXcQ',
      'kick:xqc',
    ])
    expect(mixed.layout).toBe('focus')
    expect(mixed.audioId).toBe(mixed.tiles[2]?.id ?? '')
    // Older links keep working.
    expect(decodeSession('#s=tw.giuseppemdr%7Ctw.slash_ftv').tiles.map((t) => t.source.id)).toEqual([
      'giuseppemdr',
      'slash_ftv',
    ])
    expect(decodeSession('#s=tw.a|tw.b~m').tiles.map((t) => [t.source.id, t.muted])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  test('the address it writes is the short form', () => {
    const session = defaultSession()
    session.tiles = [
      newTile({ platform: 'twitch', kind: 'live', id: 'giuseppemdr' }),
      newTile({ platform: 'twitch', kind: 'live', id: 'slash_ftv' }),
      newTile({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }),
    ]
    expect(encodeSession(session)).toBe('s=giuseppemdr+slash_ftv+yt.dQw4w9WgXcQ')
  })

  test('the default session encodes to nothing', () => {
    expect(encodeSession(defaultSession())).toBe('')
  })

  test('garbage is ignored', () => {
    const decoded = decodeSession('#s=zz.foo|v.javascript:alert(1)|tw.ok&l=nope&v=9')
    expect(decoded.tiles.map((t) => t.source.id)).toEqual(['ok'])
    expect(decoded.layout).toBe('grid')
    expect(decoded.master).toBe(1)
  })
})
