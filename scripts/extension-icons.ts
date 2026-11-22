import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

/**
 * Renders the extension's icons from `public/icon.svg`, with transparent corners, into `extension/icons/`.
 * Chrome wants the 128 px icon drawn at 96 px with 16 px of transparent margin; the small ones fill their
 * square. Run it again (`bun scripts/extension-icons.ts`) after changing the SVG, and commit the PNGs.
 */
const SIZES: { size: number; margin: number }[] = [
  { size: 16, margin: 0 },
  { size: 32, margin: 0 },
  { size: 48, margin: 0 },
  { size: 128, margin: 16 },
]

const svg = await readFile('public/icon.svg', 'utf8')
await mkdir('extension/icons', { recursive: true })
const browser = await chromium.launch()
try {
  for (const { size, margin } of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    const art = size - 2 * margin
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${art}px;height:${art}px;margin:${margin}px}</style>${svg}`,
    )
    await page.screenshot({ path: `extension/icons/icon-${size}.png`, omitBackground: true })
    await page.close()
  }
} finally {
  await browser.close()
}
console.log(`Rendered ${SIZES.length} icons into extension/icons/`)
