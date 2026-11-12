import { expect, test } from 'bun:test'
import { readUpdate } from './twitch.ts'

const update = (playback: string, fps: number, latency = 0) => ({
  eventName: 'UPDATE_STATE',
  namespace: 'twitch-embed-player-proxy',
  params: {
    channelName: 'lofigirl',
    playback,
    muted: true,
    stats: { videoStats: { fps, hlsLatencyBroadcaster: latency } },
  },
})

test('reads playback, frame rate and latency from the player messages', () => {
  expect(readUpdate(update('Playing', 30, 2.6))).toEqual({ playback: 'Playing', fps: 30, latency: 2.6 })
  // An ad: the player is "Idle" while frames keep coming.
  expect(readUpdate(update('Idle', 25))).toMatchObject({ playback: 'Idle', fps: 25 })
})

test('ignores other messages', () => {
  expect(readUpdate(null)).toBeNull()
  expect(readUpdate({ eventName: 'OTHER', params: {} })).toBeNull()
  expect(readUpdate('{"x":1}')).toBeNull()
})
