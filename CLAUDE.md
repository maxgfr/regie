# Regie: notes for agents

Static multi-stream viewer deployed on GitHub Pages. Read `PRODUCT.md` (product truth) and `DESIGN.md` (visual system) before changing UI.

## Commands

- `bun run dev`: dev server on :5173 (`scripts/dev.ts` serves the bundled page, `public/` and fonts).
- `bun run check`: typecheck + Biome + unit tests + build. It must stay green.
- `bun run test:e2e`: Playwright on `dist/` (run `bun run build` first). Every third-party request is stubbed.

## Rules that are easy to break

- **Never move a player's DOM node.** Moving an iframe reloads it.
  - `store.domOrder` is append-only. Layout order is `session.tiles`.
  - Tiles are positioned with `transform`.
  - A swap changes `session.tiles`, not the DOM.
- **Never draw anything over a player.** Twitch refuses to autoplay, or pauses, a covered player. That rules out overlays, sheets and toasts above the wall.
  - The tally is a ring outside the monitor. States go in the label strip (UMD).
  - Side panels dock in the right column. Notices sit between the wall and the console.
- **Mount a player only once its tile has a real size** (`TileView` waits for a rect). A player started hidden or at 0×0 doesn't autoplay.
- **Third-party calls must never break the room.** Wrap player calls with `safely()`, and have directory and title fetches return `null`/`[]` on failure.
- **Anonymous only:** no account, OAuth app or API key. Twitch GQL uses the public web client id and is read-only.
- Ads can't be blocked from a page. Don't add an ad-block bypass (private playlist tricks or proxies): it breaks Twitch's terms and sends viewers through third parties.
- The URL hash is the session (`core/session.ts`). Keep encoding backward compatible.

## Code

- Remix 3 components: a closure for setup, a render function, and `handle.update()`. Styles go through `css()` mixins and the tokens in `ui/styles.css`.
- Pure logic lives in `core/` with tests next to it.
- English everywhere in code. UI strings go in `src/i18n/en.ts` (source) and `fr.ts` (same keys and placeholders; a test checks this).
