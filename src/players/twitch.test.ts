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

test('ad signatures: a full buffer behind a "buffering" player; a pause is never an ad', () => {
  const read = (playback: string, fps: number, bufferSize: number) =>
    adSignature(
      readUpdate({ eventName: 'UPDATE_STATE', params: { playback, stats: { videoStats: { fps, bufferSize } } } }),
    )
  // Observed during a Twitch ad: "Buffering" with tens of seconds buffered and the stats frozen.
  expect(read('Buffering', 7, 43.2)).toBe('stuck')
  // A real stall: nothing buffered.
  expect(read('Buffering', 60, 0.1)).toBeNull()
  // A paused live player looks like this for a few seconds.
  expect(read('Idle', 31, 130)).toBeNull()
  expect(read('Idle', 0, 0)).toBeNull()
  expect(read('Playing', 60, 1.2)).toBeNull()
})

test('an ad that plays has no broadcaster latency; the stream itself has one', () => {
  const read = (latency: number, live = true, zeroLatencyIsAd = true) =>
    adSignature(
      readUpdate({
        eventName: 'UPDATE_STATE',
        params: { playback: 'Playing', stats: { videoStats: { fps: 30, hlsLatencyBroadcaster: latency } } },
      }),
      { live, zeroLatencyIsAd },
    )
  // Observed during Twitch's "preparing your stream" pre-roll, then once the stream starts.
  expect(read(0)).toBe('running')
  expect(read(7.08)).toBeNull()
  // A video has no broadcaster latency at all.
  expect(read(0, false)).toBeNull()
  // A stream that doesn't report a latency at all: 0 means nothing.
  expect(read(0, true, false)).toBeNull()
})

test('a mid-roll plays over the stream while its clock stands still', () => {
  // Observed during a "commercial break in progress": playing at 30 fps, latency and clock frozen.
  const update = readUpdate({
    eventName: 'UPDATE_STATE',
    params: {
      playback: 'Playing',
      currentTime: 17.78,
      stats: { videoStats: { fps: 30, hlsLatencyBroadcaster: 1.57 } },
    },
  })
  expect(update?.time).toBe(17.78)
  expect(adSignature(update, { frozenMs: 500 })).toBeNull()
  expect(adSignature(update, { frozenMs: 2500 })).toBe('running')
  expect(adSignature(update, { frozenMs: 2500, live: false })).toBeNull()
})

test('the "commercial break" slate plays with the clock running and the latency frozen', () => {
  // Observed on chowh1: playing at 21 fps, the clock moving, the latency stuck at 2.367 s for 25 s and more.
  const update = readUpdate({
    eventName: 'UPDATE_STATE',
    params: {
      playback: 'Playing',
      currentTime: 45.24,
      stats: { videoStats: { fps: 21, hlsLatencyBroadcaster: 2.367, bufferSize: 4.9 } },
    },
  })
  expect(adSignature(update, { latencyFrozenMs: 6500 })).toBe('running')
  // On a stream the latency changes every two or three seconds.
  expect(adSignature(update, { latencyFrozenMs: 2900 })).toBeNull()
  expect(adSignature(update, { latencyFrozenMs: 6500, live: false })).toBeNull()
  // A paused player is never an ad, whatever its latency.
  const paused = readUpdate({
    eventName: 'UPDATE_STATE',
    params: { playback: 'Idle', stats: { videoStats: { fps: 3, hlsLatencyBroadcaster: 2.367 } } },
  })
  expect(adSignature(paused, { latencyFrozenMs: 60_000 })).toBeNull()
})

test('ignores other messages', () => {
  expect(readUpdate(null)).toBeNull()
  expect(readUpdate({ eventName: 'OTHER', params: {} })).toBeNull()
  expect(readUpdate('{"x":1}')).toBeNull()
})
