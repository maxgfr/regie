import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/** Players are other sites: the tests replace them with blank pages, so they run offline and stay stable. */
async function offline(page: Page) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
  )
}

const KICK = ['one', 'two', 'three', 'four', 'five'].map((name) => `https://kick.com/${name}`)

test.beforeEach(async ({ page }) => {
  await offline(page)
})

test('the empty wall is a test card with the source input, and passes axe', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Regie' })).toBeVisible()
  await expect(page.locator('#empty-input')).toBeVisible()
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
  expect(results.violations.map((v) => v.id)).toEqual([])
})

test('pasting five links builds the wall, and the address keeps the setup', async ({ page }) => {
  await page.goto('/')
  await page.locator('#empty-input').fill(KICK.join(' '))
  await page.locator('#empty-input').press('Enter')
  await expect(page.locator('[data-tile]')).toHaveCount(5)
  // Five streams switch to the main monitor + strip layout.
  await expect(page.getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/#s=kk\.one\+kk\.two/)
  await page.reload()
  await expect(page.locator('[data-tile]')).toHaveCount(5)
})

test('changing the layout moves the players without reloading them', async ({ page }) => {
  // Generic embeds: unlike Kick, they never reload to mute, so any reload would come from the layout.
  await page.goto(`/#s=${[1, 2, 3, 4, 5].map((n) => `w.https://example.com/player/${n}`).join('|')}`)
  await expect(page.locator('[data-tile] iframe')).toHaveCount(5)
  await page.evaluate(() => {
    for (const [index, frame] of document.querySelectorAll('[data-tile] iframe').entries()) {
      ;(frame as HTMLIFrameElement & { mark?: number }).mark = index
      frame.addEventListener('load', () => {
        ;(window as unknown as { reloads: number }).reloads =
          ((window as unknown as { reloads?: number }).reloads ?? 0) + 1
      })
    }
  })
  const before = await page.locator('[data-tile]').first().boundingBox()
  await page.keyboard.press('l')
  await page.keyboard.press('l')
  await page.waitForTimeout(500)
  const after = await page.locator('[data-tile]').first().boundingBox()
  expect(after).not.toEqual(before)
  const same = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tile] iframe')].every(
      (frame, index) => (frame as HTMLIFrameElement & { mark?: number }).mark === index,
    ),
  )
  expect(same).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { reloads?: number }).reloads ?? 0)).toBe(0)
})

test('number keys put a stream on air, shift + number on the main monitor', async ({ page }) => {
  await page.goto('/#s=kk.one|kk.two|kk.three&l=focus')
  await expect(page.locator('[data-tile]')).toHaveCount(3)
  await page.locator('#stage').click({ position: { x: 2, y: 2 } })
  await page.keyboard.press('2')
  await expect(page.locator('[data-tile][data-tally="pgm"]')).toHaveAttribute('aria-label', /^2\./)
  await page.keyboard.press('Shift+3')
  await expect(page.locator('[data-tile][data-tally="pvw"]')).toHaveAttribute('aria-label', /^3\./)
  await expect(page).toHaveURL(/f=2/)
})

test('an ad marked with A hands the sound to another stream', async ({ page }) => {
  await page.goto('/#s=kk.one|kk.two')
  await page.locator('[data-tile]').first().hover()
  await page.keyboard.press('a')
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'true')
  await expect(page.locator('[data-tile]').nth(1)).toHaveAttribute('data-tally', 'pgm')
  await page.keyboard.press('a')
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-tally', 'pgm')
})

/** A fake official Twitch embed: the real player.twitch.tv script is replaced by a stub that records instances. */
const FAKE_TWITCH = `window.__players = []
window.Twitch = { Player: class {
  static READY='ready'; static PLAY='play'; static PLAYING='playing'; static PAUSE='pause'
  static ENDED='ended'; static ONLINE='online'; static OFFLINE='offline'; static PLAYBACK_BLOCKED='playback_blocked'
  constructor(element) {
    this.listeners = {}
    const frame = document.createElement('iframe')
    frame.src = 'about:blank'
    element.append(frame)
    this.iframe = frame
    window.__players.push(this)
  }
  addEventListener(event, cb) { (this.listeners[event] ??= []).push(cb) }
  emit(event) { for (const cb of this.listeners[event] ?? []) cb() }
  setVolume() {} setMuted() {} play() { this.plays = (this.plays ?? 0) + 1 } pause() {} seek() {}
  getCurrentTime() { return 0 } isPaused() { return false }
  getPlaybackStats() { return {} } getQualities() { return [] } setQuality() {}
} }`

type FakePlayer = { emit(event: string): void; iframe: HTMLIFrameElement; plays?: number }

/** Sends the UPDATE_STATE message the real Twitch iframe posts to its host page. */
function twitchUpdate(page: Page, index: number, params: Record<string, unknown>) {
  return page.evaluate(
    ([i, p]) => {
      const player = (window as unknown as { __players: FakePlayer[] }).__players[i as number] as FakePlayer
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { eventName: 'UPDATE_STATE', params: p },
          origin: 'https://player.twitch.tv',
          source: player.iframe.contentWindow,
        }),
      )
    },
    [index, params] as const,
  )
}

/** Mounts two fake Twitch players; `play` lists the ones that already showed the stream. */
async function twitchWall(page: Page, play: number[], options = '') {
  await page.clock.install()
  await page.route('https://player.twitch.tv/js/embed/v1.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TWITCH }),
  )
  await page.goto(`/#s=tw.alpha|tw.beta&l=focus${options}`)
  await expect(page.locator('[data-tile]')).toHaveCount(2)
  await page.waitForFunction(() => (window as unknown as { __players?: unknown[] }).__players?.length === 2)
  await page.evaluate((play) => {
    const players = (window as unknown as { __players: FakePlayer[] }).__players
    players.forEach((player, index) => {
      player.emit('ready')
      if (play.includes(index)) player.emit('playing')
    })
  }, play)
}

const players = (page: Page) =>
  page.evaluate(() => (window as unknown as { __players?: unknown[] }).__players?.length ?? 0)

/** "Buffering" with tens of seconds buffered, for more than eight seconds: an ad that holds the stream. */
async function twitchAd(page: Page, index: number) {
  const ad = { playback: 'Buffering', stats: { videoStats: { fps: 7, bufferSize: 43.2 } }, muted: true }
  await twitchUpdate(page, index, ad)
  await page.clock.fastForward(8200)
  await twitchUpdate(page, index, ad)
}

test('a Twitch player that reports an ad gets the badge, the sound moves, and one reload', async ({ page }) => {
  // Reloading for ads is off unless asked for (`ar=1`): a reload cuts the stream.
  await twitchWall(page, [0, 1], '&ar=1')
  // Both have shown their stream for a while: the next ad is a mid-roll.
  await page.clock.fastForward(40_000)
  // A paused live player keeps reporting frames for a few seconds: that is never an ad.
  const paused = { playback: 'Idle', stats: { videoStats: { fps: 31, bufferSize: 130 } }, muted: true }
  await twitchUpdate(page, 0, paused)
  await page.clock.fastForward(12_000)
  await twitchUpdate(page, 0, paused)
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'false')
  await twitchAd(page, 0)
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'true')
  await expect(page.locator('[data-tile]').nth(1)).toHaveAttribute('data-tally', 'pgm')
  // A mid-roll is reloaded once it is confirmed.
  await page.waitForFunction(() => (window as unknown as { __players?: unknown[] }).__players?.length === 3, null, {
    timeout: 8000,
  })
  // The fresh player reports Playing: the ad is over.
  await page.evaluate(() => {
    const player = (window as unknown as { __players: FakePlayer[] }).__players[2] as FakePlayer
    player.emit('ready')
    player.emit('playing')
  })
  await twitchUpdate(page, 2, { playback: 'Playing', stats: { videoStats: { fps: 60 } }, muted: false, volume: 1 })
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'false')
})

test('by default an ad is never reloaded: a reload cuts the stream', async ({ page }) => {
  await twitchWall(page, [0, 1])
  await page.clock.fastForward(40_000)
  await twitchAd(page, 0)
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'true')
  await page.clock.fastForward(6000)
  expect(await players(page)).toBe(2)
})

test('a pre-roll ad is not reloaded: a fresh player would only start it again', async ({ page }) => {
  // The first player never showed the stream: its ad is a pre-roll.
  await twitchWall(page, [1], '&ar=1')
  await twitchAd(page, 0)
  await expect(page.locator('[data-tile]').first()).toHaveAttribute('data-ad', 'true')
  await page.waitForTimeout(5000)
  expect(await players(page)).toBe(2)
})

test('a Twitch player that stops on its own is started again, unless the wall was paused', async ({ page }) => {
  await twitchWall(page, [0, 1])
  const plays = () =>
    page.evaluate(() => (window as unknown as { __players: FakePlayer[] }).__players.map((p) => p.plays ?? 0))
  const before = await plays()
  // Twitch paused the first player (another window in front, another monitor in full screen…).
  await page.evaluate(() => (window as unknown as { __players: FakePlayer[] }).__players[0]?.emit('pause'))
  // A short pause is a rebuffer: left alone.
  await page.clock.fastForward(1000)
  expect((await plays())[0]).toBe(before[0])
  await page.clock.fastForward(3000)
  await expect.poll(async () => (await plays())[0]).toBeGreaterThan(before[0] ?? 0)
  // Paused with Regie's own key: it stays paused.
  await page.evaluate(() => {
    ;(window as unknown as { regie: { pauseAll(): void } }).regie.pauseAll()
    ;(window as unknown as { __players: FakePlayer[] }).__players[1]?.emit('pause')
  })
  const held = await plays()
  await page.clock.fastForward(10_000)
  expect((await plays())[1]).toBe(held[1])
})

/** The viewer switches to another tab and back: the page is told it is hidden, then visible. */
function setHidden(page: Page, hidden: boolean) {
  return page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test('an ad keeps its verdict while the tab is hidden, and its player is started again on return', async ({ page }) => {
  await twitchWall(page, [0, 1])
  await page.clock.fastForward(40_000)
  await twitchAd(page, 0)
  const first = page.locator('[data-tile]').first()
  await expect(first).toHaveAttribute('data-ad', 'true')
  await expect(page.locator('[data-tile]').nth(1)).toHaveAttribute('data-tally', 'pgm')
  const plays = () =>
    page.evaluate(() => (window as unknown as { __players: FakePlayer[] }).__players.map((p) => p.plays ?? 0))
  // Another tab in front for 30 s: Twitch stops the ad, its messages say nothing about it.
  await setHidden(page, true)
  for (let i = 0; i < 6; i++) {
    await twitchUpdate(page, 0, { playback: 'Idle', stats: { videoStats: { fps: 0 } }, muted: true })
    await page.clock.fastForward(5000)
  }
  await expect(first).toHaveAttribute('data-ad', 'true')
  await expect(page.locator('[data-tile]').nth(1)).toHaveAttribute('data-tally', 'pgm')
  const before = await plays()
  await setHidden(page, false)
  await page.clock.fastForward(2000)
  // The player stopped in its ad gets a play(); the one playing its stream is left alone.
  await expect.poll(async () => (await plays())[0]).toBeGreaterThan(before[0] ?? 0)
  expect((await plays())[1]).toBe(before[1])
  await expect(first).toHaveAttribute('data-ad', 'true')
  // The ad was over: the stream itself plays, its clock and latency moving.
  for (let i = 0; i < 8; i++) {
    await twitchUpdate(page, 0, {
      playback: 'Playing',
      currentTime: 100 + i / 2,
      stats: { videoStats: { fps: 30, hlsLatencyBroadcaster: 2 + (i % 3) / 10 } },
      muted: true,
    })
    await page.clock.fastForward(500)
  }
  await expect(first).toHaveAttribute('data-ad', 'false')
})

test('sync mode marks streams from the label strip', async ({ page }) => {
  await page.goto('/#s=kk.one|kk.two')
  await page.locator('#stage').click({ position: { x: 2, y: 2 } })
  await page.keyboard.press('s')
  await expect(page.getByRole('heading', { name: 'Line up the streams' })).toBeVisible()
  await page.getByRole('button', { name: 'Mark 1' }).click()
  await page.getByRole('button', { name: 'Mark 2' }).click()
  await expect(page.getByRole('button', { name: 'Line up', exact: true })).toBeEnabled()
})

test('the library saves setups in this browser', async ({ page }) => {
  await page.goto('/#s=kk.one|kk.two')
  await page.getByRole('button', { name: 'Library' }).click()
  await page.getByRole('tab', { name: 'Setups' }).click()
  await page.getByLabel('Name').fill('Finals')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /^Finals/ })).toBeVisible()
  await page.goto('/')
  await page.getByRole('button', { name: 'Library' }).click()
  await page.getByRole('tab', { name: 'Setups' }).click()
  await page.getByRole('button', { name: /^Finals/ }).click()
  await expect(page.locator('[data-tile]')).toHaveCount(2)
})

test('French is picked from the browser language', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' })
  const page = await context.newPage()
  await offline(page)
  await page.goto('/')
  await expect(page.getByText('Charger une config')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
  await context.close()
})

test('a monitor in full screen fills the display, picture included', async ({ page }) => {
  await page.goto('/#s=w.https://example.com/a|w.https://example.com/b|w.https://example.com/c')
  await expect(page.locator('[data-tile] iframe')).toHaveCount(3)
  const tile = page.locator('[data-tile]').first()
  await tile.getByRole('button', { name: 'Full screen' }).click()
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  // The label strip is hidden in full screen: the picture takes the whole display.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = (document.querySelector('[data-tile] .player') as HTMLElement).getBoundingClientRect()
        return [Math.round(box.width), Math.round(box.height)]
      }),
    )
    .toEqual([1440, 900])
  await page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
  await expect
    .poll(() =>
      page.evaluate(() => (document.querySelector('[data-tile] .player') as HTMLElement).getBoundingClientRect().width),
    )
    .toBeLessThan(1440)
})

test('muting or unmuting inside a player is followed, not overridden', async ({ page }) => {
  await page.goto('/#s=v.https://example.com/a.mp4|v.https://example.com/b.mp4')
  await expect(page.locator('[data-tile] video')).toHaveCount(2)
  const first = page.locator('[data-tile]').first()
  const second = page.locator('[data-tile]').nth(1)
  await expect(first).toHaveAttribute('data-tally', 'pgm')
  // Using a player's controls activates the page, which allows sound (the script below can't).
  await page.keyboard.press('Shift')
  // The viewer turns on the second player's sound from its own controls: it goes on air.
  await page.evaluate(() => {
    const video = document.querySelectorAll('[data-tile] video')[1] as HTMLVideoElement
    video.muted = false
    video.volume = 0.6
  })
  await expect(second).toHaveAttribute('data-tally', 'pgm')
  // Then mutes it from the player: Regie keeps it muted instead of turning it back on.
  await page.evaluate(() => {
    ;(document.querySelectorAll('[data-tile] video')[1] as HTMLVideoElement).muted = true
  })
  await expect(second.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => (document.querySelectorAll('[data-tile] video')[1] as HTMLVideoElement).muted)).toBe(
    true,
  )
})

const RELAY = 'http://localhost:7878'
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Regie-Ad' }

/**
 * A relay saved in this browser, stubbed: `health` says whether it answers, `play` whether its playlist
 * loads. The playlists are real HLS; the segment never arrives, so the player stays on the relay, loading.
 */
/** The qualities the relay stub's master offers with `levels` (one 360p otherwise). */
const LEVELS = [
  'BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000',
  'BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=30.000',
  'BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30.000',
]

async function relay(
  page: Page,
  { health, play, levels = false }: { health: boolean; play: boolean; levels?: boolean },
) {
  const requests: string[] = []
  await page.addInitScript((url) => {
    localStorage.setItem('regie:preferences', JSON.stringify({ relayUrl: url, relayKey: '' }))
  }, RELAY)
  await page.route('https://player.twitch.tv/js/embed/v1.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TWITCH }),
  )
  await page.route(`${RELAY}/**`, async (route) => {
    const url = new URL(route.request().url())
    requests.push(url.pathname + url.search)
    if (url.pathname === '/health') {
      return health
        ? route.fulfill({
            status: 200,
            headers: CORS,
            json: { ok: true, version: 1, ytdlp: '2026.10.26', ffmpeg: '7.1' },
          })
        : route.fulfill({ status: 503, headers: CORS, body: 'down' })
    }
    const m3u8 = { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'x-regie-ad': '0' }
    if (url.pathname === '/play.m3u8') {
      if (!play) return route.fulfill({ status: 502, headers: CORS, body: 'upstream failed' })
      const variants = levels
        ? LEVELS.map((attrs) => `#EXT-X-STREAM-INF:${attrs}\n${RELAY}/v/s1/${/x(\d+)/.exec(attrs)?.[1]}p.m3u8`)
        : [`#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n${RELAY}/v/s1/360p.m3u8`]
      return route.fulfill({ status: 200, headers: m3u8, body: `#EXTM3U\n${variants.join('\n')}\n` })
    }
    if (url.pathname.endsWith('.m3u8')) {
      return route.fulfill({
        status: 200,
        headers: m3u8,
        body: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\n${RELAY}/s/s1/1.ts\n`,
      })
    }
    // Segments: never answered.
    await new Promise(() => undefined)
  })
  return requests
}

const twitchPlayers = (page: Page) =>
  page.evaluate(() => (window as unknown as { __players?: unknown[] }).__players?.length ?? 0)

test('with the relay unreachable, a Twitch stream keeps its official player', async ({ page }) => {
  await relay(page, { health: false, play: true })
  await page.goto('/#s=tw.alpha')
  await expect(page.locator('[data-tile] iframe')).toHaveCount(1)
  await expect(page.locator('[data-tile] video')).toHaveCount(0)
  expect(await twitchPlayers(page)).toBe(1)
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await expect(page.getByText('Unreachable: official players are used')).toBeVisible()
})

test('with the relay up, a Twitch stream plays from it, tagged HLS', async ({ page }) => {
  const requests = await relay(page, { health: true, play: true })
  await page.goto('/#s=tw.alpha')
  await expect(page.locator('[data-tile] video')).toHaveCount(1)
  await expect(page.locator('[data-tile] .tag[data-kind="hls"]')).toBeVisible()
  await expect
    .poll(() => requests.find((path) => path.startsWith('/play.m3u8')))
    .toBe(`/play.m3u8?src=${encodeURIComponent('https://www.twitch.tv/alpha')}`)
  await expect.poll(() => requests.includes('/v/s1/360p.m3u8')).toBe(true)
  // The official embed was never mounted, so it never had to be reloaded.
  expect(await twitchPlayers(page)).toBe(0)
  await expect(page.locator('[data-tile] iframe')).toHaveCount(0)
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await expect(page.getByText('Connected · yt-dlp 2026.10.26 · ffmpeg 7.1')).toBeVisible()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a relayed stream on air gets its sound: starting muted is not the viewer muting it', async ({ page }) => {
  await relay(page, { health: true, play: true })
  await page.goto('/#s=tw.alpha')
  const video = page.locator('[data-tile] video')
  await expect(video).toHaveCount(1)
  // hls.js sets the source later, so the player's own volume changes at its start reach Regie.
  await page.waitForTimeout(500)
  await page.keyboard.press('Shift')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false)
  await expect(page.locator('[data-tile]').getByRole('button', { name: 'Unmute' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('once the page may play sound, a silent relayed stream is not muted: a background tab would pause it', async ({
  page,
}) => {
  await relay(page, { health: true, play: true })
  await page.goto('/#s=tw.alpha+tw.beta')
  const videos = page.locator('[data-tile] video')
  await expect(videos).toHaveCount(2)
  const sound = () =>
    videos.evaluateAll((elements: HTMLVideoElement[]) => elements.map((v) => ({ muted: v.muted, volume: v.volume })))
  // Before anyone uses the page, a silent video can only autoplay muted.
  await expect.poll(async () => (await sound()).filter((s) => s.muted).length).toBeGreaterThan(0)
  await page.keyboard.press('Shift')
  await expect.poll(async () => (await sound()).some((s) => s.muted)).toBe(false)
  const silent = (await sound()).filter((s) => s.volume < 0.01)
  expect(silent).toHaveLength(1)
  expect(silent[0]?.volume).toBeGreaterThan(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a relayed stream picks its quality by itself, or plays the one chosen under it', async ({ page }) => {
  const requests = await relay(page, { health: true, play: true, levels: true })
  await page.goto('/#s=tw.alpha')
  const menu = page.locator('[data-tile]').getByRole('combobox', { name: 'Stream quality' })
  await expect(menu).toBeVisible()
  await expect(menu.locator('option')).toHaveText([/^Auto/, '1080p60', '720p', '360p'])
  await expect(menu).toHaveValue('')
  await menu.selectOption({ label: '720p' })
  await expect(menu).not.toHaveValue('')
  await expect.poll(() => requests.some((path) => path.startsWith('/v/s1/720p.m3u8'))).toBe(true)
  await menu.selectOption({ index: 0 })
  await expect(menu).toHaveValue('')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a stream with a single quality has no quality menu', async ({ page }) => {
  await relay(page, { health: true, play: true })
  await page.goto('/#s=tw.alpha')
  await expect(page.locator('[data-tile] video')).toHaveCount(1)
  await page.waitForTimeout(500)
  await expect(page.locator('[data-tile]').getByRole('combobox', { name: 'Stream quality' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a stream the relay can’t play falls back to its official player, in place', async ({ page }) => {
  const requests = await relay(page, { health: true, play: false })
  await page.goto('/#s=tw.alpha|w.https://example.com/other')
  await expect.poll(() => requests.some((path) => path.startsWith('/play.m3u8'))).toBe(true)
  await expect.poll(() => twitchPlayers(page), { timeout: 10_000 }).toBe(1)
  const tile = page.locator('[data-tile]').first()
  await expect(tile.locator('iframe')).toHaveCount(1)
  await expect(tile.locator('video')).toHaveCount(0)
  await expect(tile.locator('.tag[data-kind="hls"]')).toHaveCount(0)
})

const SEGMENTS = 'https://video-edge-c1.example.hls.ttvnw.net'

/**
 * A fake Regie extension: its bridge, answered in the page itself (it runs before Regie's scripts, as the
 * real one does at `document_start`). `play` says whether its playlist loads. Media playlists list Twitch CDN
 * segments, as the extension's do; they are never answered, so the player stays on the extension, loading.
 */
async function extensionBridge(page: Page, { play }: { play: boolean }) {
  await page.route('https://player.twitch.tv/js/embed/v1.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TWITCH }),
  )
  await page.route(`${SEGMENTS}/**`, () => new Promise<void>(() => undefined))
  await page.addInitScript(
    ({ play, segments }) => {
      const requests: string[] = []
      ;(window as unknown as { __bridge: string[] }).__bridge = requests
      const post = (message: unknown) => window.postMessage(message, location.origin)
      const hello = () => post({ source: 'regie-extension', type: 'hello', version: '9.9.9' })
      const m3u8 = { 'content-type': 'application/vnd.apple.mpegurl' }
      const answer = (url: string) => {
        const path = url.split('?')[0] ?? ''
        if (path === '/health') {
          const health = { ok: true, version: 1, ytdlp: null, ffmpeg: null, platforms: ['twitch'], extension: true }
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(health) }
        }
        if (path === '/play.m3u8') {
          if (!play) return { status: 502, headers: {}, body: '{"ok":false}' }
          const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n/v/s1/360p.m3u8\n'
          return { status: 200, headers: m3u8, body }
        }
        if (path.startsWith('/v/')) {
          const body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.000,live\n${segments}/v1/segment/1.ts\n`
          return { status: 200, headers: { ...m3u8, 'x-regie-ad': '0' }, body }
        }
        return { status: 404, headers: {}, body: '' }
      }
      window.addEventListener('message', (event) => {
        const data = event.data as { source?: string; type?: string; id?: string; url?: string } | null
        if (event.source !== window || data?.source !== 'regie-page') return
        if (data.type === 'ping') hello()
        if (data.type !== 'request' || typeof data.url !== 'string') return
        requests.push(data.url)
        post({ source: 'regie-extension', type: 'response', id: data.id, ...answer(data.url) })
      })
      hello()
    },
    { play, segments: SEGMENTS },
  )
}

const bridgeRequests = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bridge?: string[] }).__bridge ?? [])

test('with the Regie extension, Twitch plays through it and Kick keeps its embed', async ({ page }) => {
  await extensionBridge(page, { play: true })
  const segments: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(SEGMENTS)) segments.push(request.url())
  })
  await page.goto('/#s=tw.alpha|kk.beta')
  await expect(page.locator('[data-tile] video')).toHaveCount(1)
  await expect
    .poll(() => bridgeRequests(page))
    .toContain(`/play.m3u8?src=${encodeURIComponent('https://www.twitch.tv/alpha')}`)
  // The variant, relative in the master playlist, is asked of the extension too.
  await expect.poll(() => bridgeRequests(page)).toContain('/v/s1/360p.m3u8')
  // Segments come straight from Twitch's CDN, not through the bridge.
  await expect.poll(() => segments).toContain(`${SEGMENTS}/v1/segment/1.ts`)
  await expect(page.locator('[data-tile] .tag[data-kind="hls"]')).toHaveCount(1)
  // The Twitch embed was never mounted; the Kick tile is an iframe.
  expect(await twitchPlayers(page)).toBe(0)
  await expect(page.locator('[data-tile] iframe')).toHaveCount(1)
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  await expect(page.getByText('Regie extension connected: Twitch without ads')).toBeVisible()
  await expect(page.getByText('Off: official players are used')).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a stream the extension can’t play falls back to its official player, in place', async ({ page }) => {
  await extensionBridge(page, { play: false })
  await page.goto('/#s=tw.alpha')
  await expect
    .poll(() => bridgeRequests(page))
    .toContain(`/play.m3u8?src=${encodeURIComponent('https://www.twitch.tv/alpha')}`)
  await expect.poll(() => twitchPlayers(page), { timeout: 10_000 }).toBe(1)
  const tile = page.locator('[data-tile]').first()
  await expect(tile.locator('iframe')).toHaveCount(1)
  await expect(tile.locator('video')).toHaveCount(0)
})

test('a server relay that is up takes precedence over the extension', async ({ page }) => {
  const requests = await relay(page, { health: true, play: true })
  await extensionBridge(page, { play: true })
  await page.goto('/#s=tw.alpha')
  await expect(page.locator('[data-tile] video')).toHaveCount(1)
  await expect.poll(() => requests.some((path) => path.startsWith('/play.m3u8'))).toBe(true)
  expect((await bridgeRequests(page)).some((path) => path.startsWith('/play.m3u8'))).toBe(false)
  expect(await twitchPlayers(page)).toBe(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a live video stays at real time, whatever a speed extension sets; a VOD keeps its speed', async ({ page }) => {
  await page.goto('/#s=vl.https://example.com/live.m3u8|v.https://example.com/a.mp4')
  await expect(page.locator('[data-tile] video')).toHaveCount(2)
  const rates = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tile] video')].map((node) => {
      const video = node as HTMLVideoElement
      video.playbackRate = 3
      video.defaultPlaybackRate = 3
      return [video.playbackRate, video.defaultPlaybackRate]
    }),
  )
  expect(rates).toEqual([
    [1, 1],
    [3, 3],
  ])
})
