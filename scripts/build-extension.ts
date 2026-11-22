import { cp, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { $ } from 'bun'

/**
 * The "Regie relay" browser extension (Chrome, MV3), unpacked in `dist-extension/`.
 *
 * `--version 1.7.0`: the version to give it (the release does, with the version it is about to tag). Without
 * it, the latest `v*` tag of the repository, else the manifest's own. `--zip`: also writes
 * `regie-extension.zip`, the file attached to each GitHub release.
 */
const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: { version: { type: 'string' }, zip: { type: 'boolean', default: false } },
})
const out = 'dist-extension'
const ZIP = 'regie-extension.zip'
await rm(out, { recursive: true, force: true })
await rm(ZIP, { force: true })

/** Chrome takes one to four dot-separated integers: `1.7.0-beta.1` gives `1.7.0`. */
function chromeVersion(version: string | undefined): string | null {
  const match = /^v?(\d+(?:\.\d+){0,3})/.exec(version?.trim() ?? '')
  return match?.[1] ?? null
}

async function latestTag(): Promise<string | undefined> {
  const result = await $`git describe --tags --abbrev=0 --match ${'v*'}`.quiet().nothrow()
  return result.exitCode === 0 ? result.text().trim() : undefined
}

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

const manifest = await Bun.file('extension/manifest.json').json()
if (flags.version !== undefined && !chromeVersion(flags.version)) {
  console.error(`Not a version: ${flags.version}`)
  process.exit(1)
}
manifest.version = chromeVersion(flags.version) ?? chromeVersion(await latestTag()) ?? manifest.version
await Bun.write(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
await cp('extension/rules.json', `${out}/rules.json`)
// Rendered from `public/icon.svg` with transparent corners by `scripts/extension-icons.ts`.
await cp('extension/icons', `${out}/icons`, { recursive: true })
console.log(
  `Built the extension ${manifest.version} in ${out}/ (${files} scripts); load it unpacked from chrome://extensions`,
)

if (flags.zip) {
  await $`zip -qr ../${ZIP} .`.cwd(out)
  console.log(`Zipped it into ${ZIP}`)
}
