import { describe, expect, test } from 'bun:test'
import { EXTENSION_BASE } from '../core/extension-protocol.ts'
import { type BridgeWindow, createExtensionClient, extensionPath, replyHeader } from './extension.ts'

const ORIGIN = 'http://localhost:4173'

/** The page's window, with a scripted bridge: `bridge` sees every message the page posts. */
class FakeWindow extends EventTarget {
  location = { origin: ORIGIN }
  posted: Record<string, unknown>[] = []
  bridge: ((message: Record<string, unknown>) => void) | null = null
  fail = false

  postMessage(message: unknown, targetOrigin: string) {
    if (this.fail) throw new Error('opaque origin')
    expect(targetOrigin).toBe(ORIGIN)
    const data = message as Record<string, unknown>
    this.posted.push(data)
    queueMicrotask(() => this.bridge?.(data))
  }

  /** A message from the bridge (or anyone else on `origin`). */
  send(data: unknown, origin = ORIGIN) {
    this.dispatchEvent(new MessageEvent('message', { data, origin }))
  }
}

const hello = { source: 'regie-extension', type: 'hello', version: '1.2.3' }
const response = (id: unknown, status: number, body = '', headers: Record<string, string> = {}) => ({
  source: 'regie-extension',
  type: 'response',
  id,
  status,
  headers,
  body,
})

function setup() {
  const win = new FakeWindow()
  const client = createExtensionClient(win as unknown as BridgeWindow)
  return { win, client }
}

describe('extension client', () => {
  test('a ping finds the extension; without one, it is null after the timeout', async () => {
    const { win, client } = setup()
    win.bridge = (message) => {
      if (message.type === 'ping') win.send(hello)
    }
    expect(client.version).toBeNull()
    expect(await client.present(100)).toBe('1.2.3')
    expect(client.version).toBe('1.2.3')
    expect(win.posted).toEqual([{ source: 'regie-page', type: 'ping' }])

    const absent = setup()
    const started = Date.now()
    expect(await absent.client.present(30)).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  test('a hello sent before anyone asked is remembered, and every hello is reported', async () => {
    const { win, client } = setup()
    const seen: string[] = []
    client.onHello((version) => seen.push(version))
    win.send(hello)
    expect(await client.present(10)).toBe('1.2.3')
    expect(win.posted).toEqual([])
    win.send({ ...hello, version: '1.2.4' })
    expect(seen).toEqual(['1.2.3', '1.2.4'])
  })

  test('messages from another origin or not from the bridge are ignored', async () => {
    const { win, client } = setup()
    win.send(hello, 'https://evil.example')
    win.send({ ...hello, source: 'someone-else' })
    win.send('hello')
    expect(await client.present(20)).toBeNull()
  })

  test('each request gets its own id, and its own answer, in whatever order they come', async () => {
    const { win, client } = setup()
    const requests: Record<string, unknown>[] = []
    win.bridge = (message) => {
      if (message.type === 'request') requests.push(message)
      if (requests.length === 2) {
        const [first, second] = requests
        win.send(response('someone-elses', 200, 'nope'))
        win.send(response(second?.id, 200, `second ${second?.url}`))
        win.send(response(first?.id, 404, 'first'))
      }
    }
    const [a, b] = await Promise.all([client.fetch('/play.m3u8?src=x'), client.fetch('/v/s1/v1.m3u8')])
    expect(requests[0]?.id).not.toBe(requests[1]?.id)
    expect(a).toEqual({ status: 404, headers: {}, body: 'first' })
    expect(b).toEqual({ status: 200, headers: {}, body: 'second /v/s1/v1.m3u8' })
  })

  test('no answer in time, a refused path or a window that refuses the message: status 0', async () => {
    const { win, client } = setup()
    expect(await client.fetch('/health', { timeoutMs: 20 })).toEqual({ status: 0, headers: {}, body: '' })
    expect((await client.fetch('//evil.example/x')).status).toBe(0)
    expect((await client.fetch('https://evil.example/x')).status).toBe(0)
    win.fail = true
    expect((await client.fetch('/health')).status).toBe(0)
    expect(await client.present(1000)).toBeNull()
  })

  test('health: the worker’s answer is read, anything else is null', async () => {
    const { win, client } = setup()
    let answer: (id: unknown) => unknown = (id) =>
      response(id, 200, JSON.stringify({ ok: true, version: 1, ytdlp: null, ffmpeg: null, platforms: ['twitch'] }))
    win.bridge = (message) => {
      if (message.type === 'ping') win.send(hello)
      else win.send(answer(message.id))
    }
    expect(await client.health()).toEqual({ ytdlp: null, ffmpeg: null, platforms: ['twitch'] })
    // Reloaded since the page loaded: the bridge still says hello, but the worker no longer answers.
    answer = (id) => response(id, 0)
    expect(await client.health()).toBeNull()
    answer = (id) => response(id, 200, 'not json')
    expect(await client.health()).toBeNull()
    expect(await setup().client.health()).toBeNull()
  })
})

describe('extension playlist addresses', () => {
  test('only addresses under the extension base are sent to it', () => {
    expect(extensionPath(`${EXTENSION_BASE}/play.m3u8?src=a%2Fb`)).toBe('/play.m3u8?src=a%2Fb')
    expect(extensionPath(`${EXTENSION_BASE}/v/s1/v1.m3u8`)).toBe('/v/s1/v1.m3u8')
    expect(extensionPath('https://video-weaver.ams03.hls.ttvnw.net/v1/playlist/x.m3u8')).toBeNull()
    expect(extensionPath(`${EXTENSION_BASE}.evil.example/v/x`)).toBeNull()
    expect(extensionPath(`${EXTENSION_BASE}//evil.example/x`)).toBeNull()
  })

  test('a reply header is found whatever its case', () => {
    expect(replyHeader({ 'content-type': 'text/plain' }, 'Content-Type')).toBe('text/plain')
    expect(replyHeader({ 'Content-Type': 'text/plain' }, 'content-type')).toBe('text/plain')
    expect(replyHeader({}, 'Content-Type')).toBeNull()
  })
})
