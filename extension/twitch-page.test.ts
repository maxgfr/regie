import { expect, test } from 'bun:test'
import { pageSource } from './twitch-page.ts'

test('a channel page or a video page is played by Regie; the rest of twitch.tv keeps its player', () => {
  expect(pageSource('https://www.twitch.tv/SamuelEtienne')).toEqual({
    platform: 'twitch',
    kind: 'live',
    id: 'samueletienne',
  })
  expect(pageSource('https://www.twitch.tv/lofigirl?referrer=raid')).toMatchObject({ kind: 'live', id: 'lofigirl' })
  expect(pageSource('https://www.twitch.tv/videos/2345678901')).toMatchObject({ platform: 'twitch', kind: 'vod' })
  for (const other of [
    'https://www.twitch.tv/',
    'https://www.twitch.tv/directory/category/just-chatting',
    'https://www.twitch.tv/settings/profile',
    'https://www.twitch.tv/lofigirl/videos',
    'https://www.twitch.tv/lofigirl/clip/SomeClipSlug',
    'https://www.twitch.tv/videos',
    'https://www.twitch.tv/search?term=x',
  ])
    expect(pageSource(other)).toBeNull()
})
