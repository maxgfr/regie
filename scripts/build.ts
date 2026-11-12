import { cp, mkdir, rm } from 'node:fs/promises'
import { fontCss, fontFiles } from './fonts.ts'

/** Static build for GitHub Pages: relative asset paths, so it works under `/regie/` and locally. */
await rm('dist', { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  minify: true,
  splitting: true,
  sourcemap: 'linked',
  publicPath: './',
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
await cp('public', 'dist', { recursive: true })
await mkdir('dist/fonts', { recursive: true })
for (const file of fontFiles()) await Bun.write(`dist/fonts/${file.name}`, Bun.file(file.path))
await Bun.write('dist/fonts/fonts.css', fontCss())
// Files copied as they are can't go through the bundler, so their links are added to the built page.
const page = await Bun.file('dist/index.html').text()
const links = [
  '<link rel="manifest" href="./manifest.webmanifest" />',
  '<link rel="icon" href="./icon.svg" type="image/svg+xml" />',
  '<link rel="apple-touch-icon" href="./icon-192.png" />',
  '<link rel="stylesheet" href="./fonts/fonts.css" />',
].join('')
await Bun.write('dist/index.html', page.replace('</head>', `${links}</head>`))
const size = result.outputs.reduce((sum, output) => sum + output.size, 0)
console.log(`Built ${result.outputs.length} files, ${(size / 1024).toFixed(0)} KB (fonts and public files apart)`)
