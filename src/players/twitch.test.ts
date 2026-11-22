import { expect, test } from 'bun:test'
import { readUpdate } from './twitch.ts'

test('reads playback, clock, buffer, latency and sound from the player messages', () => {
  expect(
    readUpdate({
      eventName: 'UPDATE_STATE',
      namespace: 'twitch-embed-player-proxy',
      params: {
        channelName: 'lofigirl',
        playback: 'Playing',
        currentTime: 17.78,
        muted: true,
        volume: 0.5,
        stats: { videoStats: { fps: 30, bufferSize: 4.9, hlsLatencyBroadcaster: 2.6 } },
      },
    }),
  ).toEqual({ playback: 'Playing', time: 17.78, buffer: 4.9, latency: 2.6, muted: true, volume: 0.5 })
  // A message without stats still says what the player does.
  expect(readUpdate({ eventName: 'UPDATE_STATE', params: { playback: 'Idle' } })).toEqual({ playback: 'Idle' })
})

test('ignores other messages', () => {
  expect(readUpdate(null)).toBeNull()
  expect(readUpdate({ eventName: 'OTHER', params: {} })).toBeNull()
  expect(readUpdate({ eventName: 'UPDATE_STATE', params: { playback: 3 } })).toBeNull()
  expect(readUpdate('{"x":1}')).toBeNull()
})
