import type { RelayReply } from '../core/extension-protocol.ts'
import type { Source } from '../core/types.ts'

export type PlaybackState = 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'offline'

export interface PlayerEvents {
  state(state: PlaybackState, byPlayer: boolean): void
  /** Live latency to the broadcaster in seconds (Twitch). */
  latency(seconds: number): void
  /** The viewer changed the sound inside the player itself (its mute button or volume slider). */
  userVolume(volume: number, muted: boolean): void
  /** The qualities a player can be switched to (`setQuality`), and the one it plays: on load and on each switch. */
  quality(state: QualityState): void
}

export interface QualityLevel {
  /** Value to pass back to `setQuality`. */
  id: string
  /** Shown in the menu, and how a choice is kept across a remount: `1080p60`, `720p`. */
  label: string
}

export interface QualityState {
  /** Best first. */
  levels: QualityLevel[]
  /** The level asked for, or null when the player picks it itself (from the connection and the monitor's size). */
  selected: string | null
  /** The label of the level playing now, if known: it trails `selected` until the switch is done. */
  playing: string | null
}

export interface Player {
  /** Effective volume 0..1; 0 mutes. */
  setVolume(volume: number): void
  play(): void
  pause(): void
  /** Moves the playback position; negative goes back in time (adds delay). Returns false if not possible. */
  seekBy(seconds: number): boolean
  /** Matches the stream quality to the size the player is shown at (`main` keeps automatic quality). */
  fit?(displayHeight: number, main: boolean): void
  /** Plays one of the levels it reported (`PlayerEvents.quality`), or chooses by itself again with null. */
  setQuality?(id: string | null): void
  destroy(): void
}

export interface PlayerContext {
  source: Source
  container: HTMLElement
  host: string
  events: PlayerEvents
  /** Volume to start with, so autoplay is muted until the page has had a user gesture. */
  initialVolume: number
  /**
   * The relay to play from, when one is up: a source it supports plays from it in a `<video>`. `server`:
   * the viewer's own relay at `base`; `extension`: the Regie browser extension, through its bridge.
   * `remux`: it can remux YouTube videos; `platforms`: what it plays (null: all). `onFail`: the stream never
   * started there, so the official embed takes over.
   */
  relay?: PlayerRelay
}

interface RelayCommon {
  remux: boolean
  platforms: readonly string[] | null
  onFail(): void
}

export type PlayerRelay =
  | (RelayCommon & { kind: 'server'; base: string; key: string })
  | (RelayCommon & { kind: 'extension'; load(path: string, timeoutMs: number): Promise<RelayReply> })
