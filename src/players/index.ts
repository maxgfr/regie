import { EXTENSION_BASE } from '../core/extension-protocol.ts'
import { relayable, relayUrl } from '../core/relay.ts'
import { createIframePlayer } from './iframe.ts'
import { createTikTokPlayer } from './tiktok.ts'
import { createTwitchPlayer } from './twitch.ts'
import type { Player, PlayerContext } from './types.ts'
import { createVideoPlayer } from './video.ts'
import { createYouTubePlayer } from './youtube.ts'

export function createPlayer(context: PlayerContext): Player | null {
  const { platform, kind } = context.source
  if (kind === 'unembeddable') return null
  const { relay } = context
  if (relay && relayable(context.source, relay.remux, relay.platforms)) {
    const { onFail } = relay
    if (relay.kind === 'extension') {
      // The playlists come through the extension's bridge: their address is only a key for hls.js.
      const src = relayUrl(EXTENSION_BASE, '', context.source)
      return createVideoPlayer(context, { src, forceHls: true, onFail, loadPlaylist: relay.load })
    }
    const src = relayUrl(relay.base, relay.key, context.source)
    return createVideoPlayer(context, { src, forceHls: true, onFail })
  }
  if (platform === 'twitch' && kind !== 'clip') return createTwitchPlayer(context)
  if (platform === 'youtube') return createYouTubePlayer(context)
  if (platform === 'tiktok') return createTikTokPlayer(context)
  if (platform === 'video') return createVideoPlayer(context)
  return createIframePlayer(context)
}

export type { PlaybackState, Player, PlayerContext, PlayerEvents, PlayerRelay } from './types.ts'
