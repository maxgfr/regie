# Regie

**A control room for watching several streams at once.** Put Twitch, YouTube, Kick, TikTok, Vimeo, Dailymotion and direct HLS/MP4 streams side by side. One stream has the sound and one takes the main monitor. Regie lines up the delays between streams, keeps the chats beside them and moves the sound away from a stream that goes to an ad.

**[maxgfr.github.io/regie](https://maxgfr.github.io/regie/)**: static, no account, no tracking. An optional [relay](#ad-free-relay-optional) you run yourself removes the ads.

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
  - With the [relay](#ad-free-relay-optional), Twitch, YouTube and Kick play in Regie's own player without ads. When Twitch has no ad-free stream to give, the ad is cut out: the picture holds and the sound moves to another stream. Everything below is about the official embeds.
  - When the stream on air goes to an ad, the sound moves to another stream (the one with the busiest chat if Regie can tell) and comes back when the ad ends.
  - An ad is silenced while another stream has the sound. With no other stream to take it, the ad keeps it.
  - Ads play out on their own: Regie never touches a player during one (no quality change, no pause). A Twitch player that Twitch paused because it couldn't see it (another window in front, full screen elsewhere) is started again once it can be seen.
  - Optionally (help sheet, off by default because a reload cuts the stream), a Twitch player that goes to a mid-roll ad is reloaded once the ad is confirmed: a fresh player sometimes comes back without it. Never for a pre-roll, at most once per stream every five minutes, and when the fresh player opens on an ad again, the ads of that stream simply play for a quarter of an hour.
  - Twitch only runs an ad while its player is large and visible, after a click in the player. So a small stream in an ad is shown large, next to the main monitor, until the ad ends, and a notice asks for that one click.
  - On Twitch, ads are read from the player's own state messages. Elsewhere, Regie watches for a stream whose clock stops while it should be playing. You can also press `A`.
- **Line check.** Twitch won't autoplay an embedded player smaller than 400 × 300. A small Twitch monitor is shown large for a moment until it starts, then goes back to its place.
- **Delays lined up.**
  - Press `S`, then mark the same in-game moment on each stream.
  - Streams Regie can seek are delayed to match the slowest one: YouTube (live DVR included), every VOD, direct video.
  - Twitch and Kick live streams can't be delayed from a page. They show their lead instead, unless they play through the relay.
  - `←` `→` nudge a stream by 0.25 s.
  - For multi-POV VOD replays, play, pause and ±10 s act on every stream at once.
- **Chats.**
  - The official chat of each stream sits in a tab.
  - **Merged Twitch chat** (optional): read-only and anonymous, every channel in one column. Each message is held back by its stream's latency and lead (**anti-spoiler**), so chat never reveals what the picture hasn't shown yet. It can also highlight words like "ace" or "clutch".
  - **Auto-director** (optional): when a chat spikes against its own baseline, that stream takes the sound for 20 s.
- **On autopilot.**
  - Each small Twitch monitor plays the lowest quality that still fills it (360p instead of 1080p), while the main monitor stays on auto. A five-stream wall uses a fraction of the bandwidth. Every quality change makes Twitch rebuffer, so a monitor keeps its quality through small size changes (grid to main and back, a side panel): it only switches when the picture becomes clearly too soft or more than twice too large.
  - Favourites that go live show a notice with an Add key, can be added on their own, and can raise a system notification when Regie is in the background.
  - Ended streams are labelled offline. Players that don't start get a line check, a retry and a "click to start" label.
- **Find creators.** Search Twitch and Kick channels and see who's live, with their category and viewer count. Star favourites, add every live favourite in one click, and find recent streams again.
- **The URL is the save file.** The whole setup lives in the address: copy it to share a multiview, or write one by hand:
  - `#shroud+xqc`: Twitch channels, separated by `+`.
  - `#shroud+yt.dQw4w9WgXcQ+kk.xqc&l=focus`: other platforms take a code (`yt.` YouTube video, `ytl.` YouTube live, `kk.` Kick, `twv.` Twitch VOD, `vm.` Vimeo, `dm.` Dailymotion, `v.` direct video link, `w.` any embeddable page).
  - Options: `l=focus` or `l=theater` (layout), `f=1` (main monitor, counted from 0), `a=1` (stream with the sound), `m=mix` or `m=manual` (audio mode).
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
- **In the background.** Streams keep playing in a background tab or a minimised window. Twitch pauses an ad on an official embed while the tab is hidden (an ad nobody sees doesn't count down): Regie keeps the sound away from it meanwhile and starts it again when you come back. With the [extension](#browser-extension-optional), Twitch tiles play through it, and embeds keep their ad running in a background tab. On phones, the system pauses other sites' players when the browser leaves the screen, and no web page can prevent that: keep Regie in front, or use the mini control room on a computer.

## What a web page can't do

Without the relay or the extension, Regie only uses official embeds, so it can only do what each player allows. The last row is a tile played through the [relay](#ad-free-relay-optional) or the [extension](#browser-extension-optional):

| Platform                  | Volume                         | Seek / delay     | Chat                    | Notes                                                                                              |
| ------------------------- | ------------------------------ | ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| Twitch                    | ✓                              | VODs only        | official frame + merged | live latency and ad state from the player                                                          |
| YouTube                   | ✓                              | ✓ (live DVR too) | official frame          | titles through oEmbed                                                                              |
| Kick                      | mute only (reloads the player) | –                | official frame          | live status through Kick's public API                                                              |
| TikTok                    | mute only                      | ✓                | –                       | videos only: **TikTok LIVE can't be embedded**, it opens in its own window                         |
| Vimeo                     | ✓                              | –                | –                       |                                                                                                    |
| Dailymotion               | mute only (reload)             | –                | –                       |                                                                                                    |
| HLS / MP4 link            | ✓                              | ✓                | –                       | played with hls.js where HLS isn't native                                                          |
| Through relay / extension | ✓                              | ✓ (lives too)    | unchanged               | Twitch live and VODs, YouTube, Kick (the extension: Twitch only): no ads, latency measured, hls.js |

- **Ads can't be blocked from a page alone.** Players are other sites, and Twitch puts its ads inside the video itself. Every site that embeds Twitch's player shows its ads. With the embeds, Regie moves the sound away from an ad instead. To get rid of them, run the optional [ad-free relay](#ad-free-relay-optional) or install the [Regie extension](#browser-extension-optional).
- **Extensions, without the relay.** An ad blocker such as [uBlock Origin](https://ublockorigin.com/) works inside Regie's YouTube frames. [TTV LOL PRO](https://github.com/younesaassila/ttv-lol-pro) doesn't act on Regie's embedded Twitch players: it only handles requests from `www.twitch.tv` and `m.twitch.tv` pages. The [Regie extension](#browser-extension-optional) does act on Twitch inside Regie: it runs the same engine as the relay.
- **Twitch ads wait for a click.** Twitch starts its ads paused. A page can't click inside another site's player, and the player API's `play()` doesn't start an ad either: one click on play in that player does.
- **Some Twitch channels ask for a click too.** If a channel carries a mature-content warning, Twitch waits for a click on "Start watching" in that player. Twitch also refuses to autoplay a player that is covered, so nothing in Regie is ever drawn over a player.

## Ad-free relay (optional)

The page stays static and anonymous. If you also run the relay on your machine (or deploy it), Regie plays Twitch (live and VODs), YouTube (live and videos) and Kick through it, as HLS in its own player instead of the embeds:

- no ads (see [On an ad break](#on-an-ad-break));
- full volume and seek on every relayed tile, so Twitch and Kick lives can be delayed and lined up too (`WINDOW_S` seconds of live kept);
- quality capped to the tile, live latency measured, and none of Twitch's 400×300, visibility or click rules.

Clips, TikTok, Vimeo and the rest keep their embeds, and a wall can mix both.

### Run it

You need [Bun](https://bun.sh). Twitch works with Bun alone; [yt-dlp](https://github.com/yt-dlp/yt-dlp) adds YouTube and Kick, and [ffmpeg](https://ffmpeg.org) YouTube videos.

```sh
bun run relay   # http://127.0.0.1:7878
```

Or in Docker, with Bun, yt-dlp and ffmpeg included. Build from the repository root:

```sh
docker build -f relay/Dockerfile -t regie-relay .
docker run -p 7878:7878 -e RELAY_KEY="$(openssl rand -hex 16)" regie-relay
```

Then open Regie's help sheet, enter the relay's address (and key, if any), and check it says Connected. Chrome asks once to let `maxgfr.github.io` reach your local network: allow it.

These settings stay in this browser, never in the URL: a shared link plays with or without a relay. Without a reachable relay, every tile keeps its official embed, and a relayed tile that doesn't start falls back to its embed in place.

| Variable             | Default                                | Meaning                                                                                       |
| -------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PORT`               | `7878`                                 | Port.                                                                                         |
| `HOST`               | `127.0.0.1` (`0.0.0.0` in Docker)      | Interface to listen on.                                                                       |
| `ORIGINS`            | Regie's site and the local dev servers | Pages allowed by CORS, comma-separated.                                                       |
| `RELAY_KEY`          | none                                   | Key every request must carry (`?key=`). **Set it for any relay others can reach.**            |
| `TWITCH_PLAYER_TYPE` | `popout`                               | Player type of Twitch's main stream: `site`, `popout`, `embed`, `mobile_web` or `autoplay`.   |
| `TWITCH_PROXY`       | none                                   | Your own HTTP proxy, for Twitch's token and playlist requests only. Video segments go direct. |
| `WINDOW_S`           | `180`                                  | Seconds of live stream kept, so delays between streams can be lined up.                       |

### On an ad break

Twitch decides ads when it hands out a playback token, from your IP and the player type. Regie's embedded players are `embed`, which can get a pre-roll where `site`, `popout` or `mobile_web` get none. The relay asks for its own anonymous token (`popout` by default), and when an ad break starts anyway, it:

1. tries fresh tokens with other player types (`site`, `popout`, `mobile_web`, `embed`), and serves the first ad-free stream during the break;
2. tries Android's `autoplay` stream (360p) last;
3. goes back to the main stream as soon as it is clean;
4. if every stream has ads, cuts the ad segments out: the picture holds and Regie moves the sound to another stream.

`TWITCH_PROXY` is the same idea as the [TTV LOL PRO](https://github.com/younesaassila/ttv-lol-pro) extension: a proxy in a country without Twitch ads gets a clean token. YouTube's ads are added by its player, so the streams the relay gets from yt-dlp have none.

### Trade-offs

- Relayed lives run about 18 to 28 s behind the broadcaster, against a few seconds in the embed. The anti-spoiler holds chat back to match.
- YouTube videos are remuxed by ffmpeg (no re-encode) at about 1.3× real time: you can seek only within the part already remuxed.
- Relayed lives are locked to 1× speed, since speed extensions made them stall. Videos keep any speed.

### Security

The relay listens on `127.0.0.1` by default and answers only the pages in `ORIGINS`. It isn't an open proxy: it only resolves Twitch, YouTube and Kick pages, rebuilds their URL itself, and serves playlists and segments under random ids. Everything stays anonymous: no account, cookie or API key is sent to any platform.

More in [relay/README.md](relay/README.md).

## Browser extension (optional)

The "Regie relay" Chrome extension runs the same engine as the relay, inside the browser, with nothing to run or configure. It plays **Twitch only** (live and VODs, not clips) as HLS in Regie's own player, without ads, with the same full volume, seek and latency as the relay. YouTube, Kick and the rest keep their embeds unless a server relay is up.

Build it and load it unpacked:

```sh
bun run build:extension   # writes dist-extension/
```

Then open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist-extension/`. Reload Regie: the help sheet says "Regie extension connected".

- **A server relay wins.** When a relay is set in the help sheet and answers, every tile it can play goes through it; the extension takes the Twitch tiles only when no relay is up.
- **No extension, no change.** Without it (or once it is disabled or reloaded), Twitch tiles keep their official embed, and a stream the extension can't play falls back to its embed in place.
- **Twitch embeds keep their ad in a background tab.** On Regie's pages, the extension makes the embedded Twitch players see a visible tab, so an ad on an embed (a fallback, a clip) keeps running to its end when you switch tabs.
- **On twitch.tv too.** On `www.twitch.tv` and `m.twitch.tv`, the extension puts the same engine in the worker of Twitch's own player: during an ad break, the player gets the same quality from an ad-free stream (in the codec it plays, H.264, HEVC or AV1), or the ad cut out when every stream has it. If anything fails there, the player gets Twitch's playlist untouched: at worst you see the ad. Open the console at the "Verbose" level and filter on `[Regie]` to see what it does.

What it asks for, and why:

| Permission                                                       | Why                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gql.twitch.tv`, `usher.ttvnw.net`, `*.ttvnw.net`                | The anonymous playback token and the playlists, as the relay asks for them.                           |
| `*.cloudfront.net`                                               | Twitch also serves playlists and segments from CloudFront.                                            |
| `declarativeNetRequest`                                          | Adds `Access-Control-Allow-Origin` to Twitch's video responses, only for requests from Regie's pages. |
| `maxgfr.github.io`, `localhost:5173`, `localhost:4173` (scripts) | The bridge between Regie's page and the extension, and the visible-tab fix in Twitch's player there.  |
| `www.twitch.tv`, `m.twitch.tv` (script)                          | Starts Twitch's player worker with the engine first, so its media playlists come back ad-free.        |
| `player.twitch.tv` (script)                                      | The visible-tab fix runs there, and acts only when the player is embedded in Regie.                   |

It reads no cookies and sends no account: like the relay, everything stays anonymous.

## Privacy

There is no account, server or analytics. The page talks to:

- the players and chat frames you add (Twitch, YouTube's privacy-enhanced domain, Kick…);
- YouTube, Vimeo and Dailymotion oEmbed, for video titles;
- Twitch's public web GraphQL endpoint and Kick's public API, for search and live status (anonymous, read-only);
- Twitch's public chat socket, read-only with an anonymous `justinfan` nickname, only when the merged chat is on;
- Twitch's emote CDN;
- your relay, only if you set one in the help sheet. The relay then talks to Twitch, YouTube and Kick (and to your `TWITCH_PROXY`, if set) for you.

Twitch's GraphQL endpoint is undocumented. If it changes, search and live status stop working and the rest of Regie carries on.

## Development

```sh
bun install
bun run dev               # http://localhost:5173
bun run check             # typecheck, Biome, unit tests, build, extension build
bun run test:e2e          # Playwright + axe on the build, with every player stubbed
bun run relay             # the optional ad-free relay, on http://127.0.0.1:7878
bun run build:extension   # the optional Chrome extension, in dist-extension/
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
relay/         the optional ad-free relay: a Bun server, Twitch tokens and ad breaks, yt-dlp and ffmpeg; its engine (handler.ts, stream.ts, twitch.ts) is shared with the extension
extension/     the optional Chrome extension: the relay's engine in a service worker (Twitch), the page bridge
```

Automation:

- Pushes to `main` run CI. semantic-release then tags a version from the conventional commits, and the site deploys to GitHub Pages.
- Dependabot opens one grouped pull request a week for packages and one for actions. Minor and patch updates merge on their own once CI passes.
- A daily workflow (`bun run endpoints`) checks every third-party endpoint Regie relies on, including the unofficial Twitch GraphQL. A failure opens, or comments on, one issue, and the next success closes it.

## License

[MIT](LICENSE)
