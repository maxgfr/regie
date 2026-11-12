import { expect, test } from 'bun:test'
import { sharedSources } from './pwa.ts'

test('a link shared from another app becomes a source', () => {
  const url = new URL(
    'https://maxgfr.github.io/regie/?title=Watch&text=Look%20https%3A%2F%2Fwww.twitch.tv%2Ftarik%20now',
  )
  expect(sharedSources(url)).toEqual([{ platform: 'twitch', kind: 'live', id: 'tarik' }])
  expect(sharedSources(new URL('https://x.y/?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ'))).toEqual([
    { platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' },
  ])
  expect(sharedSources(new URL('https://x.y/?text=nothing%20here'))).toEqual([])
})
