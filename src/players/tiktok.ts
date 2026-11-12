import { embedUrl } from '../platforms/embed.ts'
import { makeIframe } from './load-script.ts'
import type { Player, PlayerContext } from './types.ts'

const ORIGIN = 'https://www.tiktok.com'

/** TikTok's embed player, driven over postMessage. It only mutes; it has no volume level. */
export function createTikTokPlayer(context: PlayerContext): Player {
  const { source, container, host, events } = context
  const iframe = makeIframe(embedUrl(source, { host, muted: true }) ?? 'about:blank', `TikTok ${source.id}`)
  container.append(iframe)
  let wanted = context.initialVolume
  let ready = false
  let time = 0

  const send = (type: string, value?: unknown) =>
    iframe.contentWindow?.postMessage({ 'x-tiktok-player': true, type, value }, ORIGIN)
  const apply = () => ready && send(wanted > 0 ? 'unMute' : 'mute')

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== ORIGIN || event.source !== iframe.contentWindow) return
    const data = event.data as { 'x-tiktok-player'?: boolean; type?: string; value?: unknown }
    if (!data?.['x-tiktok-player']) return
    if (data.type === 'onPlayerReady') {
      ready = true
      apply()
      send('play')
    } else if (data.type === 'onStateChange') {
      const map: Record<number, Parameters<typeof events.state>[0]> = {
        0: 'ended',
        1: 'playing',
        2: 'paused',
        3: 'buffering',
      }
      const state = map[data.value as number]
      if (state) events.state(state, true)
    } else if (data.type === 'onCurrentTime') {
      time = (data.value as { currentTime?: number })?.currentTime ?? time
      events.progress(time)
    } else if (data.type === 'onPlayerError') events.state('offline', true)
  }
  window.addEventListener('message', onMessage)

  return {
    setVolume(volume) {
      wanted = volume
      apply()
    },
    play: () => send('play'),
    pause: () => send('pause'),
    seekBy(seconds) {
      if (!ready) return false
      send('seekTo', Math.max(0, time + seconds))
      return true
    },
    destroy() {
      window.removeEventListener('message', onMessage)
      iframe.remove()
    },
  }
}
