import { expect, test } from 'bun:test'
import {
  decayStalls,
  initialStalls,
  MAX_PENALTY,
  PENALTY_DECAY_MS,
  parseTwitchQuality,
  pickQuality,
  type Quality,
  recordStall,
  STALL_WINDOW_MS,
} from './quality.ts'

const parse = (groups: string[]) => groups.map(parseTwitchQuality).filter((q): q is Quality => q !== null)
const twitch = parse(['chunked', '720p60', '720p30', '480p30', '360p30', '160p30'])

test('a small monitor gets the lowest quality that still fills it', () => {
  expect(pickQuality(twitch, 300, false)).toBe('360p30')
  expect(pickQuality(twitch, 150, false)).toBe('160p30')
})

test('at the same height a small monitor takes the lower frame rate', () => {
  expect(pickQuality(twitch, 600, false)).toBe('720p30')
  expect(pickQuality(parse(['1080p60', '720p60', '480p30']), 600, false)).toBe('720p60')
})

test('the main monitor and unknown sizes stay on auto', () => {
  expect(pickQuality(twitch, 300, true)).toBe('auto')
  expect(pickQuality(twitch, 0, false)).toBe('auto')
  expect(pickQuality([], 300, false)).toBe('auto')
})

test('source is used when nothing smaller is tall enough', () => {
  expect(pickQuality(twitch, 1400, false)).toBe('chunked')
})

test('a stalling player steps down, never below the lowest level', () => {
  expect(pickQuality(twitch, 300, false, 1)).toBe('160p30')
  expect(pickQuality(twitch, 300, false, 5)).toBe('160p30')
  expect(pickQuality(twitch, 600, false, 1)).toBe('480p30')
  expect(pickQuality(twitch, 1400, false, 1)).toBe('720p30')
})

test('two stalls close together take one level off; a clean stretch gives it back', () => {
  let state = recordStall(initialStalls(0), 1000)
  expect(state.penalty).toBe(0)
  state = recordStall(state, 1000 + STALL_WINDOW_MS + 1)
  expect(state.penalty).toBe(0)
  state = recordStall(state, 1000 + STALL_WINDOW_MS + 5000)
  expect(state.penalty).toBe(1)
  expect(decayStalls(state, state.at + 1000).penalty).toBe(1)
  expect(decayStalls(state, state.at + PENALTY_DECAY_MS).penalty).toBe(0)
  for (let i = 0; i < 20; i++) state = recordStall(state, 100_000 + i)
  expect(state.penalty).toBe(MAX_PENALTY)
})
