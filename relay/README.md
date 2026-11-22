# Regie relay

An optional HLS relay you run yourself. With it, Regie plays Twitch, YouTube and Kick in its own `<video>` player instead of the official embeds: no Twitch ads, full volume and seek, delays you can line up, and quality matched to the tile. Without it, Regie works exactly as before.

What it relays:

- **Twitch** live and VODs, through Twitch's anonymous web API (no account). On an ad break the relay swaps in an ad-free stream (see below).
- **YouTube** lives (HLS from yt-dlp) and videos (yt-dlp + an ffmpeg remux, no re-encode). YouTube's ads are client-side, so these streams have none.
- **Kick** live and VODs (HLS from yt-dlp).

Clips, TikTok, Vimeo and the rest stay on their embeds.

## Run it locally

You need [Bun](https://bun.sh), plus [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube and Kick and [ffmpeg](https://ffmpeg.org) for YouTube videos. Twitch works with Bun alone.

```sh
bun run relay      # http://127.0.0.1:7878
```

Then open Regie's help sheet, set the relay to `http://localhost:7878` and check it says it is connected.

**Chrome asks once for local network access.** A page served over https (`maxgfr.github.io`) that talks to `localhost` triggers Chrome's "Look for and connect to devices on your local network" prompt. Allow it; the relay answers the preflight with `Access-Control-Allow-Private-Network: true`. If you denied it, re-allow it in the site settings.

## Run it with Docker

Build from the repository root, since the relay reuses Regie's link parser:

```sh
docker build -f relay/Dockerfile -t regie-relay .
docker run -p 7878:7878 -e RELAY_KEY="$(openssl rand -hex 16)" regie-relay
```

The image has Bun, yt-dlp and ffmpeg, and listens on `0.0.0.0`. **Set `RELAY_KEY` for any deployment others can reach**, and put it in Regie's relay settings too.

## Settings

| Variable             | Default                                                                | Meaning                                                                                     |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PORT`               | `7878`                                                                 | Port.                                                                                       |
| `HOST`               | `127.0.0.1` (`0.0.0.0` in Docker)                                      | Interface to listen on.                                                                     |
| `ORIGINS`            | `https://maxgfr.github.io,http://localhost:5173,http://localhost:4173` | Pages allowed by CORS, comma-separated.                                                     |
| `RELAY_KEY`          | none                                                                   | When set, every request needs `?key=<RELAY_KEY>` (401 otherwise).                           |
| `TWITCH_PROXY`       | none                                                                   | An HTTP proxy for Twitch's token, usher and playlist requests (see below).                  |
| `TWITCH_PLAYER_TYPE` | `popout`                                                               | Player type of Twitch's main stream: `site`, `popout`, `embed`, `mobile_web` or `autoplay`. |
| `WINDOW_S`           | `180`                                                                  | Seconds of live stream kept, so delays between streams can be lined up.                     |

## Twitch ads

Twitch decides ads when it hands out a playback token, from your IP and the player type. On a `stitched-ad` playlist the relay, like the [vaft script](https://github.com/ryanbr/TwitchAdSolutions) and [TTV LOL PRO](https://github.com/younesaassila/ttv-lol-pro):

1. asks for fresh anonymous tokens with other player types (`site`, `popout`, `mobile_web`, `embed`, the channel's last winner first) and serves the first ad-free stream of the same quality during the break;
2. tries Android's `autoplay` stream (lower quality, usually ad-free) last;
3. goes back to the main stream as soon as it is clean;
4. if no stream is ad-free, cuts the ad segments out: the picture holds until the break ends. The playlist still says `X-Regie-Ad: 1`, but Regie no longer reacts to ads.

A player type that had ads is left alone for 15 s. Each step is logged on one line (`ad on primary`, `probe … → clean|ad`, `serving backup …`, `back to primary`, `cutting ad segments`). To see the ad path at work, start with a player type that gets ads, for example `TWITCH_PLAYER_TYPE=embed bun run relay`. `TWITCH_PROXY` (for example a proxy in a country without Twitch ads) carries only the token, usher and playlist requests; video segments always go direct. The main stream uses the proxy and the backups go direct, so both routes get a chance.

## HTTP

| Route                            | Answer                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                    | `{ "ok": true, "version": 1, "ytdlp": "2026.10.26" \| null, "ffmpeg": "9.0.2" \| null, "platforms": ["twitch", …] }` (`youtube` and `kick` need yt-dlp) |
| `GET /play.m3u8?src=<page URL>`  | The master playlist, every URI pointing back to the relay. 400 unsupported, 404 offline, 502 upstream.                                                  |
| `GET /v/<stream>/<variant>.m3u8` | A media playlist: rolling window, ads cut, the relay's own sequence. `X-Regie-Ad: 0\|1`.                                                                |
| `GET /s/<stream>/<segment>`      | The segment, streamed (Range supported).                                                                                                                |

## Security

- **No open proxy.** `src` must parse to a Twitch, YouTube or Kick page; the relay rebuilds the canonical URL itself and never fetches what the client typed. Playlists and segments are only reachable through random ids the relay made.
- yt-dlp and ffmpeg run without a shell, with `--` before the URL.
- Streams nobody asked for in 60 s are dropped (30 min for VODs, which a paused player stops asking for). YouTube remux folders live in the system temp folder and are deleted with their stream.
- Everything is anonymous: no account, cookie or API key is sent to any platform.
