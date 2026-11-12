# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun + TypeScript + Remix 3 (`remix/component`, rendered entirely in the browser with `createRoot`). Bun's HTML bundler, Biome, `bun test`, Playwright. Static build deployed to GitHub Pages at `https://maxgfr.github.io/regie/`. Chosen by the owner: "Bun, TS and a recently released framework".

## Users

Viewers who follow several live streams at the same moment: an esports tournament with the main cast and four player POVs or co-streams, a multi-POV VOD replay, a group of friends streaming the same game, or an event broadcast on Twitch and YouTube at once. They sit at a desktop or laptop, often for hours, often in the evening, and mostly watch rather than click.

## Product Purpose

Regie puts several streams from any platform on one screen, lays them out for the screen it runs on, decides which one is heard, lines up their delays and keeps the chats beside them. Success: setting up a five-stream multiview takes seconds, the right stream is always the one you hear, and nothing (chat, ads, latency) spoils or interrupts the match.

## Positioning

A control room for viewers. It treats a multiview like a broadcast gallery: one stream on air (it has the sound), one on the main monitor, and the others in preview. On top of that it works across platforms, needs no account, and runs as a static page. It measures and lines up the delays between streams, holds back chat so it doesn't spoil, and moves the sound away from a stream that goes to an ad.

## Operating Context

- A desktop browser, full screen or a large window, sometimes several monitors. Long sessions, with sound.
- Links are pasted from Twitch, YouTube, Kick, TikTok, Vimeo, Dailymotion, direct HLS/MP4 or any embeddable page.
- A setup is shared by copying the address: the whole session lives in the URL hash.

## Capabilities and Constraints

- **Anonymous by design.** No account, no OAuth app, no API key. Only official embeds, plus Twitch's public anonymous read-only chat socket (opt-in).
- **Static hosting.** No server: everything runs in the visitor's browser.
- **Iframes are cross-origin.** Regie only controls what each player's official API exposes:
  - Twitch: volume, mute, VOD seek, live latency.
  - YouTube: volume, mute, seek, including live DVR.
  - TikTok: mute, seek.
  - Kick and Dailymotion: mute only, by reloading the iframe.
  - Vimeo: volume over postMessage.
- TikTok LIVE cannot be embedded; it opens in its own window.
- Interface in English (source) and French.

## Product Principles

1. One stream has the sound, always visible at a glance.
2. Never reload a player the user is watching: layout changes only move it.
3. Say plainly what a platform does not allow, instead of faking it.
4. The URL is the save file.
5. Keyboard first for the people who watch for hours; mouse for everything else.

## Accessibility & Inclusion

Keyboard operable throughout, visible focus, `prefers-reduced-motion` honoured, WCAG AA contrast on the chrome. Tally state is never conveyed by colour alone (label + colour).
