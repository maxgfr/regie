/**
 * The extension's service worker: the relay engine, in the browser, for Twitch, Kick and YouTube videos. It
 * serves the same HTTP contract as `bun run relay` through messages from the bridge, with no server and no
 * port. Media playlists keep the platforms' own segment URLs ('direct'), which the page fetches from the CDN.
 */

import { createRelayHandler, RELAY_API_VERSION } from '../relay/handler.ts'
import { openKick, openYouTubeVideo, YOUTUBE_IOS_UA } from '../relay/hls-origin.ts'
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
    platforms: ['twitch', 'kick', 'youtube'],
    // YouTube videos as YouTube's own HLS; its lives need tokens only a real player gets, so they keep the embed.
    youtubeVideos: true,
    youtubeLive: false,
    extension: true,
    extensionVersion: version,
  }),
  source: (src) => {
    const source = canonicalize(src)
    if (!source) return null
    const network = (url: string, init?: RequestInit) => fetch(url, init)
    if (source.platform === 'twitch') return { key: source.page, open: () => openTwitch(source, twitch) }
    if (source.platform === 'kick') return { key: source.page, open: () => openKick(source, network) }
    if (source.platform === 'youtube' && source.kind === 'vod')
      return { key: source.page, open: () => youtubeReady.then(() => openYouTubeVideo(source.id, network)) }
    return null
  },
})

/**
 * YouTube's player API turns away a request that says it is the iOS app but comes from a browser extension:
 * for the extension's own requests (no tab), it goes without the extension's Origin and with the app's
 * User-Agent, as yt-dlp sends it.
 */

const YOUTUBE_RULES: chrome.declarativeNetRequest.Rule[] = [
  '||www.youtube.com/youtubei/v1/player',
  '||manifest.googlevideo.com/',
].map((urlFilter, index) => ({
  id: 900 + index,
  priority: 1,
  action: {
    type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
    requestHeaders: [
      { header: 'user-agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: YOUTUBE_IOS_UA },
      { header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
      { header: 'referer', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
    ],
  },
  condition: {
    urlFilter,
    tabIds: [chrome.tabs.TAB_ID_NONE],
    resourceTypes: ['xmlhttprequest', 'other'] as chrome.declarativeNetRequest.ResourceType[],
  },
}))
const youtubeReady = chrome.declarativeNetRequest
  .updateSessionRules({ removeRuleIds: YOUTUBE_RULES.map((rule) => rule.id), addRules: YOUTUBE_RULES })
  .catch((error: unknown) => console.log(`YouTube header rules not set: ${String(error)}`))

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
