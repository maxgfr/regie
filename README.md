# Regie

**A control room for watching several streams at once.** Put Twitch, YouTube, Kick, TikTok, Vimeo, Dailymotion and direct HLS/MP4 streams side by side. One stream has the sound and one takes the main monitor. Regie lines up the delays between streams, keeps the chats beside them and moves the sound away from a stream that goes to an ad.

**[maxgfr.github.io/regie](https://maxgfr.github.io/regie/)**: static, no account, no tracking.

Built for the evening when a tournament runs on five channels at once: the main cast and four player POVs, all with sound, each a few seconds out of step.

## What it does

- **A wall laid out for your screen.**
  - **Grid** tries every row × column split and keeps the one with the largest 16:9 pictures.
  - **Main** puts one large monitor next to a strip of the others. It picks a side strip or a bottom strip from your screen's shape.
  - **Theater** shows one stream full size with the others as picture-in-picture.
  - Players are never moved in the page, so changing the layout never reloads a stream.
- **One stream on air.**
  - **Solo**: only the stream on air plays sound. A red tally marks it, as in a TV gallery.
  - **Blend**: the other streams stay audible, lowered by a fader.
  - **Manual**: one fader per stream.
  - Switching can be a **cut** or a 600 ms **crossfade**.
  - Hold `Alt` to listen to the stream under the pointer.
  - A player's own mute button and volume slider work too: Regie follows them. Unmuting another stream inside its player puts it on air.
- **Ads.**
  - When the stream on air goes to an ad, the sound moves to another stream (the one with the busiest chat if Regie can tell) and comes back when the ad ends.
  - Ads stay silent.
  - A Twitch player that goes to an ad is reloaded, on its own: a fresh player sometimes comes back without the ad. It is tried at most twice per stream every five minutes, so a stubborn ad can't loop. This can be turned off in the help sheet.
  - Twitch only runs an ad while its player is large and visible, after a click in the player. So a small stream in an ad is shown large, next to the main monitor, until the ad ends, and a notice asks for that one click.
  - On Twitch, ads are read from the player's own state messages. Elsewhere, Regie watches for a stream whose clock stops while it should be playing. You can also press `A`.
- **Line check.** Twitch won't autoplay a player smaller than 400 × 300. A small Twitch monitor is shown large for a moment until it starts, then goes back to its place.
- **Delays lined up.**
  - Press `S`, then mark the same in-game moment on each stream.
  - Streams Regie can seek are delayed to match the slowest one: YouTube (live DVR included), every VOD, direct video.
  - Twitch and Kick live streams can't be delayed from a page. They show their lead instead.
  - `←` `→` nudge a stream by 0.25 s.
  - For multi-POV VOD replays, play, pause and ±10 s act on every stream at once.
- **Chats.**
  - The official chat of each stream sits in a tab.
  - **Merged Twitch chat** (optional): read-only and anonymous, every channel in one column. Each message is held back by its stream's latency and lead (**anti-spoiler**), so chat never reveals what the picture hasn't shown yet. It can also highlight words like "ace" or "clutch".
  - **Auto-director** (optional): when a chat spikes against its own baseline, that stream takes the sound for 20 s.
- **On autopilot.**
  - Each small Twitch monitor plays the lowest quality that still fills it (360p instead of 1080p), while the main monitor stays on auto. A five-stream wall uses a fraction of the bandwidth.
  - Favourites that go live show a notice with an Add key, can be added on their own, and can raise a system notification when Regie is in the background.
  - Ended streams are labelled offline. Players that don't start get a line check, a retry and a "click to start" label.
- **Find creators.** Search Twitch and Kick channels and see who's live, with their category and viewer count. Star favourites, add every live favourite in one click, and find recent streams again.
- **The URL is the save file.** The whole setup lives in the address: copy it to share a multiview.
  - Named setups, favourites, history and your last settings stay in this browser.
  - Export everything to a JSON file and import it elsewhere.
- **Keyboard first.**
  - `1`–`9` put a stream on air, `⇧ 1`–`9` put it on the main monitor.
  - `L` changes the layout, `C` shows the chat, `B` opens the library, `F` goes full screen, `M` mutes, `T` switches cut / crossfade, `/` adds a stream, `?` shows help.
- **Mini control room** (`P`): the stream on air in an always-on-top picture-in-picture window, with keys to switch streams, so a match keeps playing while you use other apps. Chrome and Edge, on a computer.
- **An installable app (PWA).**
  - Share a Twitch or YouTube link to Regie from another app (Android) to add it to the wall, even when Regie is already open.
  - A shortcut opens creator search.
  - The interface works offline, though the streams need the network.
  - English and French. The screen stays awake while streams play.
- **In the background.** Streams keep playing in a background tab or a minimised window. On phones, the system pauses other sites' players when the browser leaves the screen, and no web page can prevent that: keep Regie in front, or use the mini control room on a computer.

## What a web page can't do

Regie only uses official embeds, so it can only do what each player allows:

| Platform       | Volume                         | Seek / delay     | Chat                    | Notes                                                                      |
| -------------- | ------------------------------ | ---------------- | ----------------------- | -------------------------------------------------------------------------- |
| Twitch         | ✓                              | VODs only        | official frame + merged | live latency and ad state from the player                                  |
| YouTube        | ✓                              | ✓ (live DVR too) | official frame          | titles through oEmbed                                                      |
| Kick           | mute only (reloads the player) | –                | official frame          | live status through Kick's public API                                      |
| TikTok         | mute only                      | ✓                | –                       | videos only: **TikTok LIVE can't be embedded**, it opens in its own window |
| Vimeo          | ✓                              | –                | –                       |                                                                            |
| Dailymotion    | mute only (reload)             | –                | –                       |                                                                            |
| HLS / MP4 link | ✓                              | ✓                | –                       | played with hls.js where HLS isn't native                                  |

- **Ads can't be blocked from a page.** Players are other sites, and Twitch puts its ads inside the video itself. Every site that embeds Twitch's player shows its ads, and the remaining workarounds are extensions, userscripts or proxies. Regie keeps ads silent and takes the sound elsewhere instead. To block ads, use a browser extension such as [uBlock Origin](https://ublockorigin.com/).
- **Twitch ads wait for a click.** Twitch starts its ads paused. A page can't click inside another site's player, and the player API's `play()` doesn't start an ad either: one click on play in that player does.
- **Some Twitch channels ask for a click too.** If a channel carries a mature-content warning, Twitch waits for a click on "Start watching" in that player. Twitch also refuses to autoplay a player that is covered, so nothing in Regie is ever drawn over a player.

## Privacy

There is no account, server or analytics. The page talks to:

- the players and chat frames you add (Twitch, YouTube's privacy-enhanced domain, Kick…);
- YouTube, Vimeo and Dailymotion oEmbed, for video titles;
- Twitch's public web GraphQL endpoint and Kick's public API, for search and live status (anonymous, read-only);
- Twitch's public chat socket, read-only with an anonymous `justinfan` nickname, only when the merged chat is on;
- Twitch's emote CDN.

Twitch's GraphQL endpoint is undocumented. If it changes, search and live status stop working and the rest of Regie carries on.

## Development

```sh
bun install
bun run dev        # http://localhost:5173
bun run check      # typecheck, Biome, unit tests, build
bun run test:e2e   # Playwright + axe on the build, with every player stubbed
```

Stack:

- [Remix 3](https://remix.run) components (`remix/component`), rendered entirely in the browser;
- Bun's HTML bundler, TypeScript, Biome, `bun test`, Playwright;
- [Lucide](https://lucide.dev) icons, and Barlow, Barlow Condensed and JetBrains Mono, self-hosted.

```
src/
  core/        pure logic, unit-tested: layout engine, audio mix, sync, ad detection, hype meter, URL session
  platforms/   link parsing, embed and chat URLs, oEmbed titles, creator search
  players/     one controller per official player API (Twitch Embed JS, YouTube IFrame API, TikTok, <video>)
  chat/        anonymous read-only Twitch chat
  app/         the store (state, audio director, chat queue) and the local library
  ui/          Remix components: stage, monitors, vision mixer console, chat dock, library, test card
```

Automation:

- Pushes to `main` run CI. semantic-release then tags a version from the conventional commits, and the site deploys to GitHub Pages.
- Dependabot opens one grouped pull request a week for packages and one for actions. Minor and patch updates merge on their own once CI passes.
- A daily workflow (`bun run endpoints`) checks every third-party endpoint Regie relies on, including the unofficial Twitch GraphQL. A failure opens, or comments on, one issue, and the next success closes it.

## License

[MIT](LICENSE)
