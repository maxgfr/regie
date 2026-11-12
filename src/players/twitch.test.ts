import { expect, test } from 'bun:test'
import { adSignature, readUpdate } from './twitch.ts'

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
  expect(readUpdate(update('Playing', 30, 2.6))).toEqual({ playback: 'Playing', fps: 30, latency: 2.6, muted: true })
  // An ad: the player is "Idle" while frames keep coming.
  expect(readUpdate(update('Idle', 25))).toMatchObject({ playback: 'Idle', fps: 25 })
})

test('ad signatures: a full buffer behind a "buffering" player, or frames while idle', () => {
  const read = (playback: string, fps: number, bufferSize: number) =>
    adSignature(
      readUpdate({ eventName: 'UPDATE_STATE', params: { playback, stats: { videoStats: { fps, bufferSize } } } }),
    )
  // Observed during a Twitch ad: "Buffering" with tens of seconds buffered and the stats frozen.
  expect(read('Buffering', 7, 43.2)).toBe('buffering')
  // A real stall: nothing buffered.
  expect(read('Buffering', 60, 0.1)).toBeNull()
  // A paused live player looks like this for a few seconds: only a long run of it counts.
  expect(read('Idle', 31, 130)).toBe('idle')
  expect(read('Idle', 0, 0)).toBeNull()
  expect(read('Playing', 60, 1.2)).toBeNull()
})

test('an ad that plays has no broadcaster latency; the stream itself has one', () => {
  const read = (latency: number, live = true) =>
    adSignature(
      readUpdate({
        eventName: 'UPDATE_STATE',
        params: { playback: 'Playing', stats: { videoStats: { fps: 30, hlsLatencyBroadcaster: latency } } },
      }),
      live,
    )
  // Observed during Twitch's "preparing your stream" pre-roll, then once the stream starts.
  expect(read(0)).toBe('running')
  expect(read(7.08)).toBeNull()
  // A video has no broadcaster latency at all.
  expect(read(0, false)).toBeNull()
})

test('ignores other messages', () => {
  expect(readUpdate(null)).toBeNull()
  expect(readUpdate({ eventName: 'OTHER', params: {} })).toBeNull()
  expect(readUpdate('{"x":1}')).toBeNull()
})
