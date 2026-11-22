import { describe, expect, test } from 'bun:test'
import type { LoaderCallbacks, LoaderConfiguration, PlaylistLoaderContext } from 'hls.js'
import { EXTENSION_BASE, type RelayReply } from '../core/extension-protocol.ts'
import { bridgePlaylistLoader } from './bridge-loader.ts'

const config = { loadPolicy: { maxLoadTimeMs: 1234 } } as unknown as LoaderConfiguration
const context = (url: string) => ({ url, responseType: 'text', type: 'level' }) as unknown as PlaylistLoaderContext

/** Runs one load and resolves with the callback hls.js got. */
function run(url: string, reply: RelayReply | Promise<RelayReply>, calls: [string, number][] = []) {
  const Loader = bridgePlaylistLoader((path, timeoutMs) => {
    calls.push([path, timeoutMs])
    return Promise.resolve(reply)
  })
  const loader = new Loader({} as never)
  return new Promise<{ kind: string; args: unknown[]; loader: InstanceType<typeof Loader> }>((resolve) => {
    const callbacks: LoaderCallbacks<PlaylistLoaderContext> = {
      onSuccess: (...args) => resolve({ kind: 'success', args, loader }),
      onError: (...args) => resolve({ kind: 'error', args, loader }),
      onTimeout: (...args) => resolve({ kind: 'timeout', args, loader }),
    }
    loader.load(context(url), config, callbacks)
  })
}

describe('extension playlist loader', () => {
  test('a playlist comes through the bridge, with its headers readable', async () => {
    const calls: [string, number][] = []
    const body = '#EXTM3U\n#EXTINF:2.000,live\nhttps://video-edge.example/1.ts\n'
    const result = await run(
      `${EXTENSION_BASE}/v/s1/v1.m3u8`,
      { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body },
      calls,
    )
    expect(calls).toEqual([['/v/s1/v1.m3u8', 1234]])
    expect(result.kind).toBe('success')
    const [response, stats, , network] = result.args as [
      { url: string; data: string; code: number },
      { loaded: number },
      unknown,
      Response,
    ]
    expect(response).toEqual({ url: `${EXTENSION_BASE}/v/s1/v1.m3u8`, data: body, code: 200 })
    expect(stats.loaded).toBe(body.length)
    // hls.js reads the headers of a `Response`, case aside.
    expect(network.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl')
    expect(result.loader.getResponseHeader?.('CONTENT-TYPE')).toBe('application/vnd.apple.mpegurl')
  })

  test('an extension that does not answer, or an error status, is a load error', async () => {
    const gone = await run(`${EXTENSION_BASE}/play.m3u8?src=x`, { status: 0, headers: {}, body: '' })
    expect(gone.kind).toBe('error')
    expect((gone.args[0] as { code: number }).code).toBe(0)
    expect(gone.args[2]).toBeNull()
    const failed = await run(`${EXTENSION_BASE}/play.m3u8?src=x`, { status: 502, headers: {}, body: '{}' })
    expect(failed.kind).toBe('error')
    expect((failed.args[0] as { code: number }).code).toBe(502)
  })

  test('an address outside the extension is never sent to it', async () => {
    const calls: [string, number][] = []
    const result = await run('https://example.com/play.m3u8', { status: 200, headers: {}, body: '' }, calls)
    expect(result.kind).toBe('error')
    expect(calls).toEqual([])
  })

  test('an aborted load reports nothing more', async () => {
    let release: (reply: RelayReply) => void = () => undefined
    const Loader = bridgePlaylistLoader(() => new Promise((resolve) => (release = resolve)))
    const loader = new Loader({} as never)
    const seen: string[] = []
    loader.load(context(`${EXTENSION_BASE}/v/s1/v1.m3u8`), config, {
      onSuccess: () => seen.push('success'),
      onError: () => seen.push('error'),
      onTimeout: () => seen.push('timeout'),
      onAbort: () => seen.push('abort'),
    })
    loader.abort()
    release({ status: 200, headers: {}, body: '#EXTM3U\n' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen).toEqual(['abort'])
    expect(loader.stats.aborted).toBe(true)
  })
})
