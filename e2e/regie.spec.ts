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
