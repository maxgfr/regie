import { expect, test } from 'bun:test'
import { parseTwitchQuality, pickQuality, type Quality } from './quality.ts'

const twitch = ['chunked', '720p60', '720p30', '480p30', '360p30', '160p30']
  .map(parseTwitchQuality)
  .filter((q): q is Quality => q !== null)

test('a small monitor gets the lowest quality that still fills it', () => {
  expect(pickQuality(twitch, 300, false)).toBe('360p30')
  expect(pickQuality(twitch, 150, false)).toBe('160p30')
  expect(pickQuality(twitch, 600, false)).toBe('720p60')
})

test('the main monitor and unknown sizes stay on auto', () => {
  expect(pickQuality(twitch, 300, true)).toBe('auto')
  expect(pickQuality(twitch, 0, false)).toBe('auto')
  expect(pickQuality([], 300, false)).toBe('auto')
})

test('source is used when nothing smaller is tall enough', () => {
  expect(pickQuality(twitch, 1400, false)).toBe('chunked')
})
