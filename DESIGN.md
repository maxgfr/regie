# Design

## World (pinned by the owner: "régie broadcast")

The gallery of a TV control room, specifically its **multiviewer wall** and **vision mixer**. People who watch esports know this look from broadcast backstage shots. Regie borrows the grammar, not a costume:

- **Monitors (tiles).** Video sits edge to edge on black. Under each picture there is an **UMD** (under-monitor display): a strip with the source number, the name, the platform and a timecode or delay in mono.
- **Tally.** A **red PGM** border plus an `ON AIR` label marks the stream that has the sound. A **green PVW** border marks the main monitor when it is not the one on air. Amber marks an `AD` or an off-air tile. Tally is always a label as well as a colour.
- **Audio bars.** A thin vertical meter on the right edge of each monitor. It shows the chat activity ("hype"), which is the only level Regie can read from a cross-origin player.
- **Vision mixer (console).** At the bottom: two rows of illuminated, numbered keys, **PGM / SON** (who is heard) and **MAIN** (who takes the large monitor), then a **CUT / MIX** transition toggle, faders and layout keys. The keys light like real ones: unlit dark plastic, lit with an inner glow of their colour.
- **Test card.** The empty state is a test card (vertical colour bars, a centred identity box with a crosshair circle) with the source input in the middle.

## Palette

| Token      | Value     | Use                                     |
| ---------- | --------- | --------------------------------------- |
| `--ground` | `#0b0c0d` | wall behind the monitors                |
| `--panel`  | `#141618` | console, chat column                    |
| `--key`    | `#1d2023` | unlit keys, inputs                      |
| `--line`   | `#2a2e32` | separators, bezel edges                 |
| `--text`   | `#e6e8e3` | labels                                  |
| `--dim`    | `#9097a0` | secondary text (≥ 4.5:1 on panel)       |
| `--pgm`    | `#ff3b30` | on air, red tally                       |
| `--pvw`    | `#2fd36b` | main monitor, green tally               |
| `--amber`  | `#ffb020` | ads, warnings, delay badges, focus ring |
| `--signal` | `#5ac8fa` | merged-chat channel accent fallback     |

Dark comes from the use scene: video watched for hours, often at night. The chrome stays quiet so the pictures lead; colour is reserved for state (tally, ads).

## Type

- **Barlow Condensed** 500/600/700: UMD names, console keys, headings. Uppercase with `0.04em` tracking on keys and labels only.
- **Barlow** 400/500: body text, chat.
- **JetBrains Mono** 400/500: timecodes, delays, latency, counters. Always `font-variant-numeric: tabular-nums`. It is measurement, never decoration.
- All three are self-hosted through `@fontsource` (no third-party font request).

## Shape and depth

- Monitors: square corners (broadcast hardware), 1px bezel line; the tally is a 3px inset border.
- Keys: 4px radius, inner shadow when unlit, coloured glow (`box-shadow` with offset 0 1px plus a blur) when lit.
- No cards, no glass. Elevation exists only for menus and the help sheet (one soft shadow).

## Motion

- One authored moment: when the layout changes, monitors glide to their new position (`transform` only, 380 ms, exponential ease-out); their size is a cut, so no player is resized on every frame. Iframes never move in the DOM.
- A cut is instant. A **MIX** transition crossfades the audio over 600 ms, and the PGM key fills from left to right over the same time.
- The tally appears without fading (like real tally relays). `prefers-reduced-motion` turns every glide into an instant cut.

## Icons

Lucide, 1.75px stroke, 16–18px. No emoji, no unicode glyphs for icons.

## Browser surfaces

Selection in amber on black, an amber focus ring (2px, 2px offset), thin dark scrollbars in the chat, mono tabular numbers.
