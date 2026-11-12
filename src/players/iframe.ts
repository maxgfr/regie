import { embedUrl } from '../platforms/embed.ts'
import { platformLabel } from '../platforms/parse.ts'
import { makeIframe } from './load-script.ts'
import type { Player, PlayerContext } from './types.ts'

/**
 * Players with no usable JS API (Kick, Dailymotion, any embeddable page). Muting means reloading the
 * iframe with the `muted` parameter; Vimeo understands volume over postMessage.
 */
export function createIframePlayer(context: PlayerContext): Player {
  const { source, container, host, events } = context
  let muted = context.initialVolume <= 0
  const src = () => embedUrl(source, { host, muted }) ?? 'about:blank'
  const iframe = makeIframe(src(), `${platformLabel(source.platform)} ${source.id}`)
  if (source.platform === 'iframe')
    iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-presentation', 'allow-popups')
  container.append(iframe)
  iframe.addEventListener('load', () => events.state('playing', true), { once: true })
  const reloadable = source.platform === 'kick' || source.platform === 'dailymotion'

  return {
    setVolume(volume) {
      if (source.platform === 'vimeo') {
        iframe.contentWindow?.postMessage(
          JSON.stringify({ method: 'setVolume', value: volume }),
          'https://player.vimeo.com',
        )
        return
      }
      const next = volume <= 0
      if (next === muted || !reloadable) return
      muted = next
      iframe.src = src()
    },
    play() {
      if (source.platform === 'vimeo') iframe.contentWindow?.postMessage(JSON.stringify({ method: 'play' }), '*')
    },
    pause() {
      if (source.platform === 'vimeo') iframe.contentWindow?.postMessage(JSON.stringify({ method: 'pause' }), '*')
    },
    seekBy: () => false,
    destroy() {
      iframe.remove()
    },
  }
}
