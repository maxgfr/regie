import type { LayoutMode, Rect } from './types.ts'

export interface LayoutTile {
  id: string
  aspect: number
}

export interface LayoutInput {
  tiles: LayoutTile[]
  width: number
  height: number
  mode: LayoutMode
  focusId: string | null
  gap?: number
  /** Fixed height under each picture (the label strip), so the picture itself keeps its aspect. */
  chrome?: number
}

export interface Placed extends Rect {
  id: string
  /** Main tile of `focus` and `theater`. */
  main: boolean
  /** Drawn above the others (picture in picture). */
  overlay: boolean
}

interface Grid {
  cols: number
  rows: number
  cellW: number
  cellH: number
}

/** Rows × cols that give the largest cells of `aspect` for `n` items in `w × h`. */
export function bestGrid(n: number, w: number, h: number, aspect: number, gap: number, chrome = 0): Grid {
  let best: Grid = { cols: 1, rows: Math.max(1, n), cellW: 0, cellH: 0 }
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols)
    const maxW = (w - gap * (cols - 1)) / cols
    const maxH = (h - gap * (rows - 1)) / rows - chrome
    if (maxW <= 0 || maxH <= 0) continue
    const cellW = Math.min(maxW, maxH * aspect)
    // On a tie, prefer more columns: the screen is usually wider than tall, and 3 + 2 reads better than 2 + 2 + 1.
    if (cellW >= best.cellW - 0.5) best = { cols, rows, cellW, cellH: cellW / aspect + chrome }
  }
  return best
}

/** Lays out `n` cells of `aspect` in `area`, centred, with an incomplete last row centred too. */
export function gridRects(n: number, area: Rect, aspect: number, gap: number, chrome = 0): Rect[] {
  if (n === 0) return []
  const { cols, rows, cellW, cellH } = bestGrid(n, area.w, area.h, aspect, gap, chrome)
  const totalH = rows * cellH + (rows - 1) * gap
  const top = area.y + (area.h - totalH) / 2
  const rects: Rect[] = []
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(cols, n - row * cols)
    const rowW = inRow * cellW + (inRow - 1) * gap
    const left = area.x + (area.w - rowW) / 2
    for (let col = 0; col < inRow; col++) {
      rects.push({ x: left + col * (cellW + gap), y: top + row * (cellH + gap), w: cellW, h: cellH })
    }
  }
  return rects
}

/** The largest rect of `aspect` that fits in `area`, centred. */
export function fit(area: Rect, aspect: number, chrome = 0): Rect {
  const w = Math.max(0, Math.min(area.w, (area.h - chrome) * aspect))
  const h = w / aspect + chrome
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h }
}

function cellAspect(tiles: LayoutTile[]): number {
  const portrait = tiles.filter((tile) => tile.aspect < 1).length
  return portrait > tiles.length / 2 ? 9 / 16 : 16 / 9
}

/** Fits a tile of its own aspect inside the cell it was given (TikTok in a 16:9 cell, etc.). */
function inCell(cell: Rect, aspect: number, chrome: number): Rect {
  return Math.abs(cell.w / (cell.h - chrome) - aspect) < 0.01 ? cell : fit(cell, aspect, chrome)
}

interface FocusCandidate {
  main: Rect
  others: Rect[]
  score: number
}

/**
 * One large main tile and the others in a strip beside it or below it.
 * Tries side and bottom strips of every thickness and keeps the arrangement that gives the main tile
 * the most room while the others stay watchable.
 */
function focusLayout(
  main: LayoutTile,
  others: LayoutTile[],
  w: number,
  h: number,
  gap: number,
  chrome: number,
): FocusCandidate {
  const aspect = cellAspect(others.length ? others : [main])
  let best: FocusCandidate | null = null
  for (const side of ['right', 'bottom'] as const) {
    for (let pct = 0.12; pct <= 0.5; pct += 0.01) {
      let strip: Rect
      let mainArea: Rect
      if (side === 'right') {
        const sw = Math.round(w * pct)
        strip = { x: w - sw, y: 0, w: sw, h }
        mainArea = { x: 0, y: 0, w: w - sw - gap, h }
      } else {
        const sh = Math.round(h * pct)
        strip = { x: 0, y: h - sh, w, h: sh }
        mainArea = { x: 0, y: 0, w, h: h - sh - gap }
      }
      if (mainArea.w <= 0 || mainArea.h <= 0) continue
      let mainRect = fit(mainArea, main.aspect, chrome)
      const cells = gridRects(others.length, strip, aspect, gap, chrome)
      const small = cells[0] ? cells[0].w * cells[0].h : 0
      const mainSize = mainRect.w * mainRect.h
      // The main tile matters most, but a strip of postage stamps is useless: reward the small tiles,
      // and penalise those far below a third of the main tile's width.
      const watchable = cells[0] ? Math.min(1, cells[0].w / (mainRect.w * 0.3)) : 1
      const score = mainSize + 0.6 * small * others.length * watchable - (watchable < 0.6 ? mainSize : 0)
      // Pull the main tile against the strip, so the empty space sits on the outer edge.
      if (side === 'right') mainRect = { ...mainRect, x: Math.max(0, strip.x - gap - mainRect.w) }
      else mainRect = { ...mainRect, y: Math.max(0, strip.y - gap - mainRect.h) }
      if (!best || score > best.score) best = { main: mainRect, others: cells, score }
    }
  }
  return best ?? { main: fit({ x: 0, y: 0, w, h }, main.aspect, chrome), others: [], score: 0 }
}

/** Where each tile goes. Pure: depends only on its input. Tiles keep their input order in the output. */
export function computeLayout(input: LayoutInput): Placed[] {
  const { tiles, width, height, mode } = input
  const gap = input.gap ?? 6
  const chrome = input.chrome ?? 0
  if (tiles.length === 0 || width <= 0 || height <= 0) return []
  const area: Rect = { x: 0, y: 0, w: width, h: height }
  const focus = tiles.find((tile) => tile.id === input.focusId) ?? tiles[0]
  if (!focus) return []

  if (mode === 'grid' || tiles.length === 1) {
    const aspect = cellAspect(tiles)
    const cells = gridRects(tiles.length, area, aspect, gap, chrome)
    return tiles.map((tile, index) => ({
      id: tile.id,
      ...inCell(cells[index] as Rect, tile.aspect, chrome),
      main: tiles.length === 1,
      overlay: false,
    }))
  }

  const others = tiles.filter((tile) => tile !== focus)

  if (mode === 'theater') {
    const main = fit(area, focus.aspect, chrome)
    const pipW = Math.max(160, Math.min(width * 0.18, 360))
    const pipAspect = cellAspect(others)
    const pipH = pipW / pipAspect + chrome
    const margin = 12
    const perRow = Math.max(1, Math.floor((width - margin) / (pipW + margin)))
    return tiles.map((tile) => {
      if (tile === focus) return { id: tile.id, ...main, main: true, overlay: false }
      const index = others.indexOf(tile)
      const row = Math.floor(index / perRow)
      const inRow = Math.min(perRow, others.length - row * perRow)
      // Left to right inside the group, which hugs the bottom-right corner: 2 3 4 reads in order.
      const col = inRow - 1 - (index % perRow)
      const cell: Rect = {
        x: width - margin - (col + 1) * pipW - col * margin,
        y: height - margin - (row + 1) * pipH - row * margin,
        w: pipW,
        h: pipH,
      }
      return { id: tile.id, ...inCell(cell, tile.aspect, chrome), main: false, overlay: true }
    })
  }

  const { main, others: cells } = focusLayout(focus, others, width, height, gap, chrome)
  return tiles.map((tile) => {
    if (tile === focus) return { id: tile.id, ...main, main: true, overlay: false }
    const cell = cells[others.indexOf(tile)] as Rect
    return { id: tile.id, ...inCell(cell, tile.aspect, chrome), main: false, overlay: false }
  })
}

/** Players refuse to work below a minimum size (Twitch: 400×300). Returns the CSS scale to apply. */
export function minimumScale(rect: Rect, minW: number, minH: number): number {
  return Math.min(1, rect.w / minW, rect.h / minH)
}
