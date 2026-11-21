/**
 * Ads in a Twitch embed, as the player's state messages show them (observed, undocumented):
 * - `Playing` while the stream's own clock stands still: a mid-roll plays over it ("commercial break in
 *   progress"), its clock frozen for `AD_FROZEN_MS`. Live streams only.
 * - `Playing` with no broadcaster latency: a pre-roll plays (a live stream reports how far behind the
 *   broadcaster it is; an ad has no broadcaster). A stream that shows no latency for longer than any ad
 *   break (`AD_BREAK_MAX_MS`) simply doesn't report one: from then on, a latency of 0 means nothing for it.
 * - `Playing` while the broadcaster latency hasn't moved for `AD_LATENCY_FROZEN_MS`, the clock running: the
 *   "commercial break in progress" slate. The stream reports a new latency every two or three seconds; the
 *   slate keeps the last one (observed: 2.367 s for 25 s and more, never above 3 s on a stream).
 * Both held for `AD_RUNNING_MS`.
 * - `Buffering` while the buffer holds many seconds: the stream waits behind an ad that doesn't move. A real
 *   stall has an empty buffer. Held for `AD_STUCK_MS`.
 *
 * A paused player is never an ad (it reads `Idle`, frames still counted for a few seconds). A wrong "ad" moves
 * the sound away and may reload the player, so every signal errs on the side of "not an ad".
 *
 * Nothing is read while the page is hidden: the browser and Twitch pause what nobody sees, and an ad Twitch
 * can't see stops counting down. The verdict is kept as it was: an ad that seemed to end in the background
 * would give the sound back to a player still in its ad.
 */
export const AD_RUNNING_MS = 3000
export const AD_FROZEN_MS = 2000
export const AD_LATENCY_FROZEN_MS = 6000
/** A latency older than this isn't fresh: what plays may not be the stream itself. */
export const LATENCY_STALE_MS = 4000
export const AD_BREAK_MAX_MS = 200_000
export const AD_STUCK_MS = 8000
/** Without any signal for this long, an ad is over even if the stream isn't playing yet. */
export const AD_GONE_MS = 3000
export const AD_MIN_BUFFER_S = 10
/**
 * Back from a hidden page, every clock starts again from zero, and Twitch takes a moment to resume what it
 * paused: an ad that was on only ends on proof that the stream itself plays (its clock and its latency both
 * moved since), not on the mere absence of a signal. Long enough for the slate to show again
 * (`AD_LATENCY_FROZEN_MS`), with room for a late message.
 */
export const AD_RETURN_GRACE_MS = AD_LATENCY_FROZEN_MS + 2000

export interface TwitchUpdate {
  playback: string
  fps: number
  /** The stream's own clock, in seconds. */
  time?: number
  /** Seconds of video buffered ahead. */
  buffer?: number
  latency?: number
  muted?: boolean
  volume?: number
}

export type AdSignature = 'running' | 'stuck' | null

/**
 * Which ad signature a state message shows, if any (see `AD_RUNNING_MS` and `AD_STUCK_MS`). `zeroLatencyIsAd`:
 * false for a stream that never reports a latency. `frozenMs`: how long the stream's clock has stood still
 * while playing. `latencyFrozenMs`: how long the broadcaster latency has stood still while playing.
 */
export function adSignature(
  update: TwitchUpdate | null,
  {
    live = true,
    zeroLatencyIsAd = true,
    frozenMs = 0,
    latencyFrozenMs = 0,
  }: { live?: boolean; zeroLatencyIsAd?: boolean; frozenMs?: number; latencyFrozenMs?: number } = {},
): AdSignature {
  if (!update) return null
  if (live && update.playback === 'Playing' && update.fps > 0) {
    if (frozenMs >= AD_FROZEN_MS) return 'running'
    if (latencyFrozenMs >= AD_LATENCY_FROZEN_MS) return 'running'
    if (zeroLatencyIsAd && update.latency === 0) return 'running'
  }
  if (update.playback === 'Buffering' && (update.buffer ?? 0) >= AD_MIN_BUFFER_S) return 'stuck'
  return null
}

export interface TwitchAdState {
  inAd: boolean
  /** The signature the last messages showed, and since when. */
  kind: AdSignature
  since: number
  /** The stream reported a broadcaster latency at least once. */
  latencyKnown: boolean
  /** A stream that never reports a latency: a latency of 0 means nothing for it. */
  latencyless: boolean
  // The stream's own clock: it stands still while an ad plays over it.
  lastTime?: number
  timeMovedAt: number
  // The broadcaster latency: it stands still while the "commercial break" slate plays.
  lastLatency?: number
  latencyMovedAt: number
  /** The last step saw a hidden page. */
  hidden: boolean
  /** Back from a hidden page, until `until` (see `AD_RETURN_GRACE_MS`). */
  back?: {
    until: number
    time?: number
    latency?: number
    clockMoved: boolean
    latencyMoved: boolean
  }
}

export interface TwitchAdStep {
  state: TwitchAdState
  inAd: boolean
  /** The stream itself (not an ad) is playing. */
  content: boolean
}

export function initialTwitchAdState(now: number): TwitchAdState {
  return {
    inAd: false,
    kind: null,
    since: 0,
    latencyKnown: false,
    latencyless: false,
    timeMovedAt: now,
    latencyMovedAt: now,
    hidden: false,
  }
}

/** The page came back: what the clocks measured while nobody watched says nothing about an ad. */
function returned(state: TwitchAdState, now: number): TwitchAdState {
  return {
    ...state,
    hidden: false,
    kind: null,
    since: now,
    timeMovedAt: now,
    latencyMovedAt: now,
    back: { until: now + AD_RETURN_GRACE_MS, clockMoved: false, latencyMoved: false },
  }
}

/** The page was hidden or shown, with or without a message from the player. */
export function twitchAdVisibility(state: TwitchAdState, hidden: boolean, now: number): TwitchAdState {
  if (hidden) return state.hidden ? state : { ...state, hidden: true }
  return state.hidden ? returned(state, now) : state
}

/**
 * One state message from the player. `switching`: a quality switch Regie asked for is in progress (it looks
 * like an ad for a moment), until the stream itself plays again with its clock past 0.
 */
export function twitchAdStep(
  previous: TwitchAdState,
  update: TwitchUpdate,
  { now, hidden, live, switching = false }: { now: number; hidden: boolean; live: boolean; switching?: boolean },
): TwitchAdStep {
  const latencyKnown = previous.latencyKnown || (update.latency !== undefined && update.latency > 0)
  if (hidden) {
    // Twitch pauses or freezes what nobody sees: no ad starts or ends here, and no clock runs.
    return { state: { ...twitchAdVisibility(previous, true, now), latencyKnown }, inAd: previous.inAd, content: false }
  }
  const state = { ...twitchAdVisibility(previous, false, now), latencyKnown }
  if (update.time !== undefined && update.time !== state.lastTime) {
    state.lastTime = update.time
    state.timeMovedAt = now
  }
  const frozenMs = update.playback === 'Playing' && update.time !== undefined ? now - state.timeMovedAt : 0
  // Only counted while playing: a latency kept through a pause says nothing.
  if (update.playback !== 'Playing' || update.latency !== state.lastLatency) {
    state.lastLatency = update.latency
    state.latencyMovedAt = now
  }
  const fresh = live && update.latency !== undefined && update.latency > 0
  const latencyFrozenMs = fresh ? now - state.latencyMovedAt : 0
  let content =
    update.playback === 'Playing' &&
    frozenMs < AD_FROZEN_MS &&
    latencyFrozenMs < LATENCY_STALE_MS &&
    (!live || update.latency === undefined || update.latency > 0)

  // Back from a hidden page, the clocks were just reset: a frozen clock or latency looks fresh for a few
  // seconds. The stream itself only counts once its clock, and its latency if it reports one, really moved.
  const back = state.back && now < state.back.until ? { ...state.back } : undefined
  if (back) {
    if (update.time !== undefined) {
      if (back.time !== undefined && update.time !== back.time) back.clockMoved = true
      back.time = update.time
    }
    if (fresh && update.playback === 'Playing') {
      if (back.latency !== undefined && update.latency !== back.latency) back.latencyMoved = true
      back.latency = update.latency
    }
    content &&= back.clockMoved && (!fresh || back.latencyMoved)
  }
  state.back = back

  const blind = switching && !(content && update.time)
  const signature = blind
    ? null
    : adSignature(update, { live, zeroLatencyIsAd: !state.latencyless, frozenMs, latencyFrozenMs })
  if (signature !== state.kind) {
    state.kind = signature
    state.since = now
  }
  if (state.kind === 'running' && !state.latencyKnown && now - state.since > AD_BREAK_MAX_MS) state.latencyless = true
  const held = state.kind !== null && now - state.since >= (state.kind === 'running' ? AD_RUNNING_MS : AD_STUCK_MS)
  // Back from a hidden page, an ad isn't over just because nothing says it is yet: Twitch is resuming it.
  const gone = !back && state.kind === null && now - state.since >= AD_GONE_MS
  state.inAd = held ? true : content || gone ? false : state.inAd
  return { state, inAd: state.inAd, content }
}
