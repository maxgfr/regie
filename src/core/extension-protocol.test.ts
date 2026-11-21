import { describe, expect, test } from 'bun:test'
import {
  EXTENSION_SOURCE,
  failedReply,
  isExtensionMessage,
  isPageMessage,
  isRelayPath,
  isRelayReply,
  isRelayRequest,
  PAGE_SOURCE,
  RELAY_MESSAGE,
} from './extension-protocol.ts'

describe('extension protocol', () => {
  test('relay paths are local paths only', () => {
    expect(isRelayPath('/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud')).toBe(true)
    expect(isRelayPath('/v/abc/def.m3u8')).toBe(true)
    expect(isRelayPath('//evil.example/x')).toBe(false)
    expect(isRelayPath('https://evil.example/x')).toBe(false)
    expect(isRelayPath(`/${'a'.repeat(5000)}`)).toBe(false)
    expect(isRelayPath(42)).toBe(false)
  })

  test('page messages', () => {
    expect(isPageMessage({ source: PAGE_SOURCE, type: 'ping' })).toBe(true)
    expect(isPageMessage({ source: PAGE_SOURCE, type: 'request', id: '1', url: '/health' })).toBe(true)
    expect(isPageMessage({ source: PAGE_SOURCE, type: 'request', id: 1, url: '/health' })).toBe(false)
    expect(isPageMessage({ source: PAGE_SOURCE, type: 'request', id: '1', url: 'https://x.example/' })).toBe(false)
    expect(isPageMessage({ source: EXTENSION_SOURCE, type: 'ping' })).toBe(false)
    expect(isPageMessage(null)).toBe(false)
    expect(isPageMessage('ping')).toBe(false)
  })

  test('extension messages', () => {
    expect(isExtensionMessage({ source: EXTENSION_SOURCE, type: 'hello', version: '1.0.0' })).toBe(true)
    expect(isExtensionMessage({ source: EXTENSION_SOURCE, type: 'hello' })).toBe(false)
    const response = { source: EXTENSION_SOURCE, type: 'response', id: '1', status: 200, headers: {}, body: '' }
    expect(isExtensionMessage(response)).toBe(true)
    expect(isExtensionMessage({ ...response, headers: null })).toBe(false)
    expect(isExtensionMessage({ ...response, source: PAGE_SOURCE })).toBe(false)
  })

  test('worker requests and replies', () => {
    expect(isRelayRequest({ type: RELAY_MESSAGE, url: '/health' })).toBe(true)
    expect(isRelayRequest({ type: RELAY_MESSAGE, url: '//x' })).toBe(false)
    expect(isRelayRequest({ type: 'other', url: '/health' })).toBe(false)
    expect(isRelayReply(failedReply())).toBe(true)
    expect(failedReply().status).toBe(0)
    expect(isRelayReply({ status: 200, headers: {} })).toBe(false)
  })
})
