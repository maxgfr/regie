import { expect, test } from 'bun:test'
import { pruneAds } from './youtube-prune.ts'

test('a YouTube player answer loses its ad placements and keeps everything else', () => {
  const answer = {
    videoDetails: { videoId: 'abc' },
    streamingData: { hlsManifestUrl: 'https://example.test/m.m3u8' },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{}],
    adSlots: [{}],
    adBreakHeartbeatParams: 'x',
  }
  expect(pruneAds(answer) as unknown).toEqual({
    videoDetails: { videoId: 'abc' },
    streamingData: { hlsManifestUrl: 'https://example.test/m.m3u8' },
  })
})

test('the ads under playerResponse go too; other values pass through untouched', () => {
  const wrapped = { playerResponse: { adPlacements: [1], videoDetails: {} }, response: {} }
  expect(pruneAds(wrapped) as unknown).toEqual({ playerResponse: { videoDetails: {} }, response: {} })
  expect(pruneAds('text')).toBe('text')
  expect(pruneAds(null)).toBeNull()
  expect(pruneAds([1, 2])).toEqual([1, 2])
  const frozen = Object.freeze({ adPlacements: [1] })
  expect(() => pruneAds(frozen)).not.toThrow()
})
