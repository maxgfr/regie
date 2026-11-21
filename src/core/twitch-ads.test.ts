import { expect, test } from 'bun:test'
import {
  AD_GONE_MS,
  AD_RETURN_GRACE_MS,
  initialTwitchAdState,
  type TwitchAdState,
  type TwitchUpdate,
  twitchAdStep,
  twitchAdVisibility,
} from './twitch-ads.ts'

// The player iframe posts its state about twice a second: the wall is simulated, message by message, instead of
// observing a real player.
const STEP_MS = 500

interface Phase {
  ms: number
  /** The update at a given time into the phase, in ms. */
  update: (t: number) => TwitchUpdate
  hidden?: boolean
}

/** Replays phases one after the other; returns the verdict after each phase, and every verdict seen. */
function replay(phases: Phase[], start: TwitchAdState = initialTwitchAdState(0), live = true) {
  let state = start
  let now = 0
  const ends: boolean[] = []
  const seen: boolean[][] = []
  for (const phase of phases) {
    const verdicts: boolean[] = []
    const hidden = phase.hidden ?? false
    state = twitchAdVisibility(state, hidden, now)
    for (let t = 0; t < phase.ms; t += STEP_MS) {
      const step = twitchAdStep(state, phase.update(t), { now, hidden, live })
      state = step.state
      verdicts.push(step.inAd)
      now += STEP_MS
    }
    ends.push(state.inAd)
    seen.push(verdicts)
  }
  return { state, ends, seen }
}

// The stream itself: the clock runs, a new latency every 2.5 s.
let base = 100
const stream = (): Phase['update'] => {
  const from = base
  base += 1000
  return (t) => ({
    playback: 'Playing',
    fps: 30,
    time: from + t / 1000,
    latency: 2 + (Math.floor(t / 2500) % 5) * 0.1,
  })
}
// A mid-roll: playing, clock and latency frozen.
const midRoll =
  (time = 50): Phase['update'] =>
  () => ({ playback: 'Playing', fps: 30, time, latency: 1.57 })
// The "commercial break" slate: the clock runs, the latency stands still.
const slate: Phase['update'] = (t) => ({ playback: 'Playing', fps: 21, time: 45 + t / 1000, latency: 2.367 })
// Twitch's "preparing your stream" pre-roll: no broadcaster latency.
const preRoll: Phase['update'] = (t) => ({ playback: 'Playing', fps: 30, time: t / 1000, latency: 0 })
// What a stopped player says.
const idle: Phase['update'] = () => ({ playback: 'Idle', fps: 0 })

test('the stream itself is never an ad', () => {
  const { ends, seen } = replay([{ ms: 60_000, update: stream() }])
  expect(ends).toEqual([false])
  expect(seen[0]?.some(Boolean)).toBe(false)
})

test('a mid-roll: playing while the clock stands still', () => {
  const { ends, seen } = replay([
    { ms: 10_000, update: stream() },
    { ms: 10_000, update: midRoll() },
    { ms: 5000, update: stream() },
  ])
  expect(ends).toEqual([false, true, false])
  // Frozen for 2 s, then held for 3 s: not before.
  expect(seen[1]?.slice(0, 9).some(Boolean)).toBe(false)
  expect(seen[1]?.[10]).toBe(true)
  // The stream plays again: over at once.
  expect(seen[2]?.[1]).toBe(false)
})

test('the "commercial break" slate: the clock runs, the latency stands still', () => {
  const { ends, seen } = replay([
    { ms: 10_000, update: stream() },
    { ms: 15_000, update: slate },
    { ms: 5000, update: stream() },
  ])
  expect(ends).toEqual([false, true, false])
  // Frozen for 6 s, then held for 3 s.
  expect(seen[1]?.slice(0, 17).some(Boolean)).toBe(false)
  expect(seen[1]?.[18]).toBe(true)
})

test('a pre-roll: playing with no broadcaster latency', () => {
  const { ends, seen } = replay([
    { ms: 8000, update: preRoll },
    { ms: 5000, update: stream() },
  ])
  expect(ends).toEqual([true, false])
  expect(seen[0]?.slice(0, 5).some(Boolean)).toBe(false)
  // A video has no broadcaster: no latency means nothing there.
  expect(replay([{ ms: 8000, update: preRoll }], initialTwitchAdState(0), false).ends).toEqual([false])
})

test('a player that stops is never an ad, and an ad ends once nothing says it is one', () => {
  expect(replay([{ ms: 30_000, update: idle }]).ends).toEqual([false])
  const { seen } = replay([
    { ms: 10_000, update: midRoll() },
    { ms: 5000, update: idle },
  ])
  expect(seen[1]?.[AD_GONE_MS / STEP_MS - 1]).toBe(true)
  expect(seen[1]?.[AD_GONE_MS / STEP_MS]).toBe(false)
})

test('a quality switch is not read as an ad', () => {
  const stuck: TwitchUpdate = { playback: 'Buffering', fps: 0, buffer: 300 }
  let state = initialTwitchAdState(0)
  for (let now = 0; now < 20_000; now += STEP_MS) {
    state = twitchAdStep(state, stuck, { now, hidden: false, live: true, switching: true }).state
  }
  expect(state.inAd).toBe(false)
})

/** A mid-roll on, then the page hidden for 30 s while Twitch says nothing useful. */
const hiddenDuringAd = (): Phase[] => [
  { ms: 10_000, update: stream() },
  { ms: 10_000, update: midRoll() },
  { ms: 30_000, update: idle, hidden: true },
]

test('a hidden page neither starts nor ends an ad', () => {
  const { ends, seen } = replay(hiddenDuringAd())
  expect(ends).toEqual([false, true, true])
  expect(seen[2]?.every(Boolean)).toBe(true)
  // Nor does it start one: a frozen clock in the background is Twitch pausing what nobody sees.
  const quiet = replay([
    { ms: 10_000, update: stream() },
    { ms: 30_000, update: midRoll(), hidden: true },
  ])
  expect(quiet.ends).toEqual([false, false])
})

test('back on the page with the ad still on: it stays an ad', () => {
  // Twitch resumes the mid-roll: the clock stands still again.
  const { ends, seen } = replay([...hiddenDuringAd(), { ms: 20_000, update: midRoll() }])
  expect(ends).toEqual([false, true, true, true])
  expect(seen[3]?.every(Boolean)).toBe(true)
  // The slate comes back instead.
  const back = replay([...hiddenDuringAd(), { ms: 20_000, update: slate }])
  expect(back.seen[3]?.every(Boolean)).toBe(true)
  // Twitch hasn't resumed it yet: the ad isn't over for that alone.
  const waiting = replay([...hiddenDuringAd(), { ms: AD_RETURN_GRACE_MS - STEP_MS, update: idle }])
  expect(waiting.seen[3]?.every(Boolean)).toBe(true)
})

test('back on the page with the ad over: the stream plays and the ad ends', () => {
  const { ends, seen } = replay([...hiddenDuringAd(), { ms: 10_000, update: stream() }])
  expect(ends).toEqual([false, true, true, false])
  // Once the clock and the latency have both moved: within one latency report.
  const over = seen[3]?.indexOf(false) ?? -1
  expect(over).toBeGreaterThan(0)
  expect(over * STEP_MS).toBeLessThanOrEqual(3000)
})

test('back on the page, nothing to show for it: the ad ends after the grace', () => {
  const { seen } = replay([...hiddenDuringAd(), { ms: AD_RETURN_GRACE_MS + 1000, update: idle }])
  expect(seen[3]?.at(-1)).toBe(false)
})

test('back on the page, a new ad needs its full signature', () => {
  // No ad before the page was hidden; a frozen clock after it.
  const { seen } = replay([
    { ms: 10_000, update: stream() },
    { ms: 30_000, update: idle, hidden: true },
    { ms: 10_000, update: midRoll() },
  ])
  expect(seen[2]?.slice(0, 9).some(Boolean)).toBe(false)
  expect(seen[2]?.at(-1)).toBe(true)
})

test('the return is noticed even when no message came while hidden', () => {
  let { state } = replay([
    { ms: 10_000, update: stream() },
    { ms: 10_000, update: midRoll() },
  ])
  state = twitchAdVisibility(state, true, 20_000)
  state = twitchAdVisibility(state, false, 50_000)
  // The clocks restart at the return: the long silence isn't read as a frozen clock, nor as the ad's end.
  expect(state.timeMovedAt).toBe(50_000)
  expect(state.latencyMovedAt).toBe(50_000)
  const step = twitchAdStep(state, idle(0), { now: 50_500, hidden: false, live: true })
  expect(step.inAd).toBe(true)
})
