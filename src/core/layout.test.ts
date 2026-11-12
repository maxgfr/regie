import { describe, expect, test } from 'bun:test'
import { bestGrid, computeLayout } from './layout.ts'
import type { LayoutMode, Rect } from './types.ts'

const landscape = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, aspect: 16 / 9 }))

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
}

function inside(r: Rect, w: number, h: number): boolean {
  return r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= w + 0.5 && r.y + r.h <= h + 0.5
}

describe('bestGrid', () => {
  test('5 streams on a 16:9 screen go 3 + 2', () => {
    expect(bestGrid(5, 1920, 1080, 16 / 9, 0).cols).toBe(3)
  })
  test('4 streams on a 16:9 screen go 2 × 2', () => {
    const grid = bestGrid(4, 1920, 1080, 16 / 9, 0)
    expect([grid.cols, grid.rows]).toEqual([2, 2])
  })
  test('a tall screen stacks', () => {
    expect(bestGrid(3, 400, 1600, 16 / 9, 0).cols).toBe(1)
  })
})

describe('computeLayout', () => {
  const screens: [number, number][] = [
    [1920, 1080],
    [2560, 1080],
    [1080, 1920],
    [1280, 720],
  ]
  const modes: LayoutMode[] = ['grid', 'focus']

  for (const [w, h] of screens) {
    for (const mode of modes) {
      for (const n of [1, 2, 3, 5, 9]) {
        test(`${mode} ${n} tiles on ${w}×${h}: inside, no overlap`, () => {
          const placed = computeLayout({ tiles: landscape(n), width: w, height: h, mode, focusId: 't0' })
          expect(placed).toHaveLength(n)
          for (const rect of placed) {
            expect(inside(rect, w, h)).toBe(true)
            expect(rect.w).toBeGreaterThan(0)
          }
          for (let i = 0; i < placed.length; i++) {
            for (let j = i + 1; j < placed.length; j++) {
              expect(overlaps(placed[i] as Rect, placed[j] as Rect)).toBe(false)
            }
          }
        })
      }
    }
  }

  test('tiles keep their input order, so the DOM order never changes', () => {
    const tiles = landscape(5)
    const placed = computeLayout({ tiles, width: 1920, height: 1080, mode: 'focus', focusId: 't3' })
    expect(placed.map((p) => p.id)).toEqual(tiles.map((t) => t.id))
  })

  test('focus: the main tile is the largest and keeps 16:9', () => {
    const placed = computeLayout({ tiles: landscape(5), width: 1920, height: 1080, mode: 'focus', focusId: 't2' })
    const main = placed.find((p) => p.main)
    expect(main?.id).toBe('t2')
    for (const p of placed) if (!p.main) expect(p.w * p.h).toBeLessThan((main?.w ?? 0) * (main?.h ?? 0))
    expect((main?.w ?? 0) / (main?.h ?? 1)).toBeCloseTo(16 / 9, 2)
  })

  test('focus: the esports case (main + 4 POVs) keeps watchable POVs', () => {
    const placed = computeLayout({ tiles: landscape(5), width: 1920, height: 1080, mode: 'focus', focusId: 't0' })
    const main = placed.find((p) => p.main) as Rect
    expect(main.w).toBeGreaterThan(1920 * 0.6)
    for (const p of placed) if (!p.main) expect(p.w).toBeGreaterThan(main.w * 0.18)
  })

  test('grid uses more of the screen than a naive one-row layout', () => {
    const placed = computeLayout({ tiles: landscape(5), width: 1920, height: 1080, mode: 'grid', focusId: null })
    const area = placed.reduce((sum, p) => sum + p.w * p.h, 0)
    expect(area / (1920 * 1080)).toBeGreaterThan(0.5)
  })

  test('theater: the others float above the main tile', () => {
    const placed = computeLayout({ tiles: landscape(3), width: 1920, height: 1080, mode: 'theater', focusId: 't1' })
    expect(placed.filter((p) => p.overlay)).toHaveLength(2)
    expect(placed.find((p) => p.main)?.id).toBe('t1')
  })

  test('portrait tiles keep their aspect inside landscape cells', () => {
    const tiles = [...landscape(2), { id: 'tt', aspect: 9 / 16 }]
    const placed = computeLayout({ tiles, width: 1920, height: 1080, mode: 'grid', focusId: null })
    const tt = placed.find((p) => p.id === 'tt') as Rect
    expect(tt.w / tt.h).toBeCloseTo(9 / 16, 2)
  })

  test('the label strip is added under the picture, which keeps 16:9', () => {
    const placed = computeLayout({
      tiles: landscape(4),
      width: 1920,
      height: 1080,
      mode: 'grid',
      focusId: null,
      chrome: 24,
    })
    for (const p of placed) expect(p.w / (p.h - 24)).toBeCloseTo(16 / 9, 2)
    for (const p of placed) expect(inside(p, 1920, 1080)).toBe(true)
  })

  test('nothing to place', () => {
    expect(computeLayout({ tiles: [], width: 100, height: 100, mode: 'grid', focusId: null })).toEqual([])
    expect(computeLayout({ tiles: landscape(2), width: 0, height: 100, mode: 'grid', focusId: null })).toEqual([])
  })
})
