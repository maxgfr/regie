import { createIframePlayer } from './iframe.ts'
import { createTikTokPlayer } from './tiktok.ts'
import { createTwitchPlayer } from './twitch.ts'
import type { Player, PlayerContext } from './types.ts'
import { createVideoPlayer } from './video.ts'
import { createYouTubePlayer } from './youtube.ts'

export function createPlayer(context: PlayerContext): Player | null {
  const { platform, kind } = context.source
  if (kind === 'unembeddable') return null
  if (platform === 'twitch' && kind !== 'clip') return createTwitchPlayer(context)
  if (platform === 'youtube') return createYouTubePlayer(context)
  if (platform === 'tiktok') return createTikTokPlayer(context)
  if (platform === 'video') return createVideoPlayer(context)
  return createIframePlayer(context)
}

export type { PlaybackState, Player, PlayerContext, PlayerEvents } from './types.ts'
