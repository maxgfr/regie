import { cp, rm } from 'node:fs/promises'

/** The "Regie relay" browser extension (Chrome, MV3), unpacked in `dist-extension/`. */
const out = 'dist-extension'
await rm(out, { recursive: true, force: true })

function failed(result: Awaited<ReturnType<typeof Bun.build>>): never {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// The code put in the worker of Twitch's player on twitch.tv: inlined into `twitch-site.js`, not a file.
const worker = await Bun.build({
  entrypoints: ['./extension/twitch-worker.ts'],
  format: 'iife',
  target: 'browser',
  minify: true,
})
const workerCode = await worker.outputs[0]?.text()
if (!worker.success || !workerCode) failed(worker)

const builds = [
  // The service worker is declared `"type": "module"`.
  { entrypoints: ['./extension/background.ts'], format: 'esm' as const },
  // Content scripts are classic scripts.
  {
    entrypoints: ['./extension/bridge.ts', './extension/twitch-visible.ts', './extension/twitch-site.ts'],
    format: 'iife' as const,
  },
]
let files = 0
for (const build of builds) {
  const result = await Bun.build({
    ...build,
    outdir: out,
    target: 'browser',
    naming: '[name].js',
    define: { __REGIE_WORKER__: JSON.stringify(workerCode) },
  })
  if (!result.success) failed(result)
  files += result.outputs.length
}

await cp('extension/manifest.json', `${out}/manifest.json`)
await cp('extension/rules.json', `${out}/rules.json`)
// Rendered from `public/icon.svg` with transparent corners by `scripts/extension-icons.ts`.
await cp('extension/icons', `${out}/icons`, { recursive: true })
console.log(`Built the extension in ${out}/ (${files} scripts); load it unpacked from chrome://extensions`)
