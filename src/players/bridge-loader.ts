import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderStats,
  NullableNetworkDetails,
  PlaylistLoaderConstructor,
  PlaylistLoaderContext,
} from 'hls.js'
import type { RelayReply } from '../core/extension-protocol.ts'
import { extensionPath, replyHeader } from '../platforms/extension.ts'

/** Loads a relay path through the extension; status 0 when it didn't answer. */
export type LoadPlaylist = (path: string, timeoutMs: number) => Promise<RelayReply>

const newStats = (): LoaderStats => ({
  aborted: false,
  loaded: 0,
  retry: 0,
  total: 0,
  chunkCount: 0,
  bwEstimate: 0,
  loading: { start: 0, first: 0, end: 0 },
  parsing: { start: 0, end: 0 },
  buffering: { start: 0, first: 0, end: 0 },
})

/**
 * The reply as a `Response`, so hls.js and Regie's ad header reader see its headers as from the network.
 * Null when it can't be one (status 0, a header the Fetch API refuses).
 */
function details(reply: RelayReply): NullableNetworkDetails {
  if (reply.status < 200 || reply.status > 599) return null
  try {
    return new Response(null, { status: reply.status, headers: reply.headers })
  } catch {
    return null
  }
}

/**
 * An hls.js playlist loader (`pLoader`) that asks the extension's bridge instead of the network. The
 * playlists' addresses live under `EXTENSION_BASE` (a reserved `.invalid` host): the master's relative
 * `/v/…` variants resolve there too. Segments are absolute Twitch CDN addresses and keep the default loader.
 */
export function bridgePlaylistLoader(load: LoadPlaylist): PlaylistLoaderConstructor {
  return class BridgePlaylistLoader implements Loader<PlaylistLoaderContext> {
    context: PlaylistLoaderContext | null = null
    stats: LoaderStats = newStats()
    #callbacks: LoaderCallbacks<PlaylistLoaderContext> | null = null
    #reply: RelayReply | null = null

    load(
      context: PlaylistLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>,
    ) {
      this.context = context
      this.#callbacks = callbacks
      const stats = this.stats
      stats.loading.start = performance.now()
      const path = extensionPath(context.url)
      const timeout = config.loadPolicy?.maxLoadTimeMs || config.timeout || 20_000
      const reply = path ? load(path, timeout) : Promise.resolve<RelayReply>({ status: 0, headers: {}, body: '' })
      reply
        .catch((): RelayReply => ({ status: 0, headers: {}, body: '' }))
        .then((result) => {
          const callbacks = this.#callbacks
          if (!callbacks || stats.aborted || this.context !== context) return
          this.#callbacks = null
          this.#reply = result
          const now = performance.now()
          stats.loading.first = Math.max(now, stats.loading.start)
          stats.loading.end = stats.loading.first
          stats.loaded = stats.total = result.body.length
          const network = details(result)
          if (result.status >= 200 && result.status < 300) {
            callbacks.onSuccess({ url: context.url, data: result.body, code: result.status }, stats, context, network)
          } else {
            const text = result.status ? `HTTP ${result.status}` : 'The extension did not answer'
            callbacks.onError({ code: result.status, text }, context, network, stats)
          }
        })
    }

    abort() {
      const { context } = this
      const callbacks = this.#callbacks
      this.#callbacks = null
      if (!context || !callbacks || this.stats.aborted) return
      this.stats.aborted = true
      callbacks.onAbort?.(this.stats, context, null)
    }

    destroy() {
      this.#callbacks = null
      this.context = null
      this.#reply = null
    }

    getResponseHeader(name: string): string | null {
      return this.#reply ? replyHeader(this.#reply.headers, name) : null
    }
  }
}
