/**
 * Self-hosted fonts: only the latin and latin-ext woff2 files of the weights Regie uses, with unicode
 * ranges, so a page only downloads what it shows. Served from `fonts/` in dev and copied into the build.
 */
const FACES: [family: string, pkg: string, weights: number[]][] = [
  ['Barlow', 'barlow', [400, 500]],
  ['Barlow Condensed', 'barlow-condensed', [500, 600, 700]],
  ['JetBrains Mono', 'jetbrains-mono', [400, 500]],
]
const SUBSETS: Record<string, string> = {
  latin:
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext':
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
}

export interface FontFile {
  name: string
  path: string
}

export function fontFiles(): FontFile[] {
  const files: FontFile[] = []
  for (const [, pkg, weights] of FACES) {
    for (const weight of weights) {
      for (const subset of Object.keys(SUBSETS)) {
        const name = `${pkg}-${subset}-${weight}-normal.woff2`
        files.push({ name, path: `node_modules/@fontsource/${pkg}/files/${name}` })
      }
    }
  }
  return files
}

export function fontCss(): string {
  const rules: string[] = []
  for (const [family, pkg, weights] of FACES) {
    for (const weight of weights) {
      for (const [subset, range] of Object.entries(SUBSETS)) {
        rules.push(
          `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${weight};src:url(./${pkg}-${subset}-${weight}-normal.woff2) format('woff2');unicode-range:${range}}`,
        )
      }
    }
  }
  return `${rules.join('\n')}\n`
}
