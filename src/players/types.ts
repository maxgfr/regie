import type { Source } from '../core/types.ts'

export type PlaybackState = 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'offline'

export interface PlayerEvents {
  state(state: PlaybackState, byPlayer: boolean): void
  /** Playback position in seconds, when the player reports one. */
  progress(time: number): void
  /** Live latency to the broadcaster in seconds (Twitch). */
  latency(seconds: number): void
  /** A platform message that suggests an ad started or ended. */
  adHint(on: boolean): void
  /** The viewer changed the sound inside the player itself (its mute button or volume slider). */
  userVolume(volume: number, muted: boolean): void
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
  destroy(): void
}

export interface PlayerContext {
  source: Source
  container: HTMLElement
  host: string
  events: PlayerEvents
  /** Volume to start with, so autoplay is muted until the page has had a user gesture. */
  initialVolume: number
}
