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
  await expect(page).toHaveURL(/#s=kk\.one%7Ckk\.two/)
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
