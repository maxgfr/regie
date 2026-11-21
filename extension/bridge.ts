/**
 * Content script on Regie's pages (isolated world): relays the page's relay requests to the service worker
 * and posts the answers back. It says hello on load and on every ping, so the page knows the extension is
 * there whichever of the two scripts starts first.
 */
import {
  EXTENSION_SOURCE,
  type ExtensionMessage,
  failedReply,
  isPageMessage,
  isRelayReply,
  RELAY_MESSAGE,
  type RelayReply,
  type RelayRequest,
} from '../src/core/extension-protocol.ts'

const version = chrome.runtime.getManifest().version

function post(message: ExtensionMessage): void {
  window.postMessage(message, location.origin)
}

function hello(): void {
  post({ source: EXTENSION_SOURCE, type: 'hello', version })
}

async function forward(url: string): Promise<RelayReply> {
  try {
    const request: RelayRequest = { type: RELAY_MESSAGE, url }
    const reply = await chrome.runtime.sendMessage<unknown>(request)
    return isRelayReply(reply) ? reply : failedReply()
  } catch {
    // The extension was reloaded or updated: this script is orphaned until the page reloads.
    return failedReply()
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return
  const data: unknown = event.data
  if (!isPageMessage(data)) return
  if (data.type === 'ping') {
    hello()
    return
  }
  const { id } = data
  void forward(data.url).then((reply) => post({ source: EXTENSION_SOURCE, type: 'response', id, ...reply }))
})

hello()
