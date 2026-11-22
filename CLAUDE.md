# Regie: notes for agents

Static multi-stream viewer deployed on GitHub Pages. Read `PRODUCT.md` (product truth) and `DESIGN.md` (visual system) before changing UI.

## Commands

- `bun run dev`: dev server on :5173 (`scripts/dev.ts` serves the bundled page, `public/` and fonts).
- `bun run check`: typecheck + Biome + unit tests + build. It must stay green.
- `bun run endpoints`: checks the real third-party endpoints (also run daily by `.github/workflows/endpoints.yml`).
- `bun run test:e2e`: Playwright on `dist/` (run `bun run build` first). Every third-party request is stubbed, the relay included.
- `bun run relay`: the optional ad-free HLS relay on :7878 (see the README).

## Rules that are easy to break

- **Never move a player's DOM node.** Moving an iframe reloads it.
  - `store.domOrder` is append-only. Layout order is `session.tiles`.
  - Tiles are positioned with `transform`.
  - A swap changes `session.tiles`, not the DOM.
- **Never draw anything over a player.** Twitch refuses to autoplay, or pauses, a covered player. That rules out overlays, sheets and toasts above the wall.
  - The tally is a ring outside the monitor. States go in the label strip (UMD).
  - Side panels dock in the right column. Notices sit between the wall and the console.
- **Twitch needs 400×300 and visibility** to autoplay. `computeLayout({ boostId })` shows one small tile large next to the main tile for a line check (`store.warmUp`).
  - A small Twitch player is rendered at 400×300 and scaled down with **`zoom`, never `transform: scale()`**: the player watches itself with an IntersectionObserver (`trackVisibility`), which reports a scaled-down transform as hidden, and Twitch pauses it for good.
- **Mount a player only once its tile has a real size** (`TileView` waits for a rect). A player started hidden or at 0×0 doesn't autoplay.
- **Third-party calls must never break the room.** Wrap player calls with `safely()`, and have directory and title fetches return `null`/`[]` on failure.
- **Anonymous only:** no account, OAuth app or API key. Twitch GQL uses the public web client id and is read-only.
- The URL hash is the session (`core/session.ts`). Keep encoding backward compatible.

## Relay (optional, `relay/`)

The page must work exactly as before without it. A relayed tile plays the relay's HLS in `players/video.ts` (hls.js); every other tile keeps its embed.

- **The relay never breaks the room.** `/health` has a 3 s timeout and returns `null` on failure. A relayed player that fails before its first picture calls `onFail`, and the store mounts the embed **in the same container** (`#remount`, never a new node). If the relay stops answering, the embeds take over.
- **Relayed tiles skip the Twitch embed constraints.** Gate embed-only behaviour on `store.embedTwitch(id)`, not on `platform === 'twitch'`: 400×300 scaling, line check, boost, quality fit, ad-blocker and "click to start" heuristics. Chat, IRC, directory and titles stay on `platform`.
- **Capabilities depend on the player:** use `store.caps(tile)`, not `capabilities(tile.source)`.
- **A silent `<video>` is never `muted` once the page may play sound** (`players/video.ts`): it plays at `SILENT_VOLUME` (-80 dB). Chrome pauses a muted or volume-0 video when its tab goes to the background, and it comes back far behind live. Before the first user gesture it has to be `muted` to autoplay.
- **Relay settings live in localStorage** (`library.relaySettings()`), never in the hash: they belong to the machine, and a shared link must play on both sides.
- At startup, players the relay could take wait for its first answer (`RELAY_WAIT_MS`), so they don't mount twice. A later status change remounts only the tiles it affects, once.
- **The browser extension (`extension/`) shares the engine** (`relay/handler.ts`, `stream.ts`, `twitch.ts`) in its service worker, Twitch only, and answers the page through its bridge (`window.postMessage`, `src/core/extension-protocol.ts`). Page code reaches it only through `src/platforms/extension.ts`, and everything must keep working without it. A server relay that is up wins over it (`pickRelay()`); the startup gate also waits for its hello and `/health`.
- **On twitch.tv, the extension rewrites Twitch's own player** (`extension/twitch-site.ts` → `twitch-worker.ts` → `relay/site.ts`): it starts the player's Amazon IVS worker with the engine first, and only the media playlists of the live masters it saw come back rewritten. Any failure hands the request back to the network (an ad beats a broken player). A backup is always asked for in the player's `supported_codecs` and served only in the codec of the variant it replaces (`codecFamily()`): an H.264 backup in an HEVC decoder is Twitch's error 4000.
- Server side: no open proxy. `src` is parsed with `parseSource()` and allow-listed; segments are served only by opaque ids the relay created; yt-dlp is spawned with an argument array (no shell) and `--` before the URL. `RELAY_KEY` is required for anything public.

## Code

- Remix 3 components: a closure for setup, a render function, and `handle.update()`. Styles go through `css()` mixins and the tokens in `ui/styles.css`.
- Pure logic lives in `core/` with tests next to it.
- English everywhere in code. UI strings go in `src/i18n/en.ts` (source) and `fr.ts` (same keys and placeholders; a test checks this).
