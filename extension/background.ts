/**
 * The extension's service worker: the relay engine, in the browser, Twitch only. It serves the same HTTP
 * contract as `bun run relay` through messages from the bridge, with no server and no port. Media playlists
 * keep Twitch's own segment URLs ('direct'), which the page fetches from the CDN itself.
 */

import { createRelayHandler, RELAY_API_VERSION } from '../relay/handler.ts'
import { canonicalize, openTwitch } from '../relay/source.ts'
import { Relay } from '../relay/stream.ts'
import { Twitch } from '../relay/twitch.ts'
import { EXTENSION_BASE, EXTENSION_ORIGINS, isRelayRequest, type RelayReply } from '../src/core/extension-protocol.ts'

/** Seconds of live stream kept, as the server's `WINDOW_S` default. */
const WINDOW_S = 180

const relay = new Relay(WINDOW_S, { segments: 'direct' })
const twitch = new Twitch({ log: (message) => console.log(message) })
const version = chrome.runtime.getManifest().version

const handler = createRelayHandler({
  relay,
  health: () => ({
    ok: true,
    version: RELAY_API_VERSION,
    ytdlp: null,
    ffmpeg: null,
    platforms: ['twitch'],
    extension: true,
    extensionVersion: version,
  }),
  source: (src) => {
    const source = canonicalize(src)
    if (source?.platform !== 'twitch') return null
    return { key: source.page, open: () => openTwitch(source, twitch) }
  },
})

async function answer(url: string): Promise<RelayReply> {
  const response = await handler.fetch(new Request(new URL(url, EXTENSION_BASE)))
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  return { status: response.status, headers, body: await response.text() }
}

/** Our own scripts ask from Regie's pages (the bridge) and from Twitch's site (`twitch-player.ts`). */
const ASKING_ORIGINS = [...EXTENSION_ORIGINS, 'https://www.twitch.tv']

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRelayRequest(message)) return undefined
  if (sender.id !== chrome.runtime.id || (sender.origin && !ASKING_ORIGINS.includes(sender.origin))) return undefined
  answer(message.url).then(sendResponse, () => sendResponse({ status: 502, headers: {}, body: '' }))
  return true
})
