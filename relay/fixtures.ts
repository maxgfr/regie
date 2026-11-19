/** Realistic upstream playlists, trimmed, for the relay tests. */

export const TWITCH_MASTER = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-weaver.fra05",MANIFEST-NODE-TYPE="weaver_cluster",SUPPRESS="true",SERVER-TIME="1795093884.25",USER-IP="203.0.113.7",SERVING-ID="abc",CLUSTER="fra05",B="false",REGION="EU"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8441899,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/source.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/720p60.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/audio.m3u8
`

/** A Twitch live media playlist: `seq` is the first media sequence, `count` 2 s segments, one PDT each. */
export function twitchLive(seq: number, count: number, options: { ad?: number[]; prefetch?: boolean } = {}): string {
  const start = Date.parse('2026-11-19T13:10:55.334Z') + (seq - 1000) * 2000
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    `#EXT-X-TWITCH-LIVE-SEQUENCE:${seq}`,
    '#EXT-X-TWITCH-ELAPSED-SECS:87062.000',
    `#EXT-X-DATERANGE:ID="playlist-creation-1",CLASS="timestamp",START-DATE="${new Date(start).toISOString()}",END-ON-NEXT=YES,X-SERVER-TIME="1795093884.72"`,
    `#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="${new Date(start).toISOString()}",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"`,
  ]
  for (let index = 0; index < count; index++) {
    const n = seq + index
    const date = new Date(start + index * 2000).toISOString()
    const ad = options.ad?.includes(n)
    if (ad && !options.ad?.includes(n - 1)) {
      let length = 0
      while (options.ad?.includes(n + length)) length++
      out.push(
        `#EXT-X-DATERANGE:ID="stitched-ad-${n}",CLASS="twitch-stitched-ad",START-DATE="${date}",DURATION=${length * 2}.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-POD-LENGTH="1"`,
      )
    }
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${date}`, ad ? '#EXTINF:2.000,Amazon' : '#EXTINF:2.000,live')
    out.push(`https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/${ad ? 'ad' : 'live'}-${n}.ts`)
  }
  if (options.prefetch) {
    out.push(`#EXT-X-TWITCH-PREFETCH:https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/live-${seq + count}.ts`)
    out.push(`#EXT-X-TWITCH-PREFETCH:https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/live-${seq + count + 1}.ts`)
  }
  return `${out.join('\n')}\n`
}

export const YOUTUBE_MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/id/4t4AQ15yj1M.1/itag/233/playlist/index.m3u8",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/id/4t4AQ15yj1M.1/itag/234/playlist/index.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=546239,CODECS="avc1.4D4015,mp4a.40.5",RESOLUTION=426x240,FRAME-RATE=30,VIDEO-RANGE=SDR,AUDIO="233",CLOSED-CAPTIONS=NONE
https://manifest.googlevideo.com/api/manifest/hls_playlist/id/4t4AQ15yj1M.1/itag/229/playlist/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2969452,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30,VIDEO-RANGE=SDR,AUDIO="234",CLOSED-CAPTIONS=NONE
https://manifest.googlevideo.com/api/manifest/hls_playlist/id/4t4AQ15yj1M.1/itag/232/playlist/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="https://manifest.googlevideo.com/iframes.m3u8"
`

export const YOUTUBE_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:272298
#EXT-X-DISCONTINUITY-SEQUENCE:51
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T12:11:36.431+00:00
#EXTINF:5.0,
https://rr2---sn-i5heen7z.googlevideo.com/videoplayback/id/4t4AQ15yj1M.1/itag/229/sq/272298/goap/clen%3D1/file/seg.ts
#EXTINF:5.0,
https://rr2---sn-i5heen7z.googlevideo.com/videoplayback/id/4t4AQ15yj1M.1/itag/229/sq/272299/goap/clen%3D1/file/seg.ts
#EXTINF:5.0,
https://rr2---sn-i5heen7z.googlevideo.com/videoplayback/id/4t4AQ15yj1M.1/itag/229/sq/272300/goap/clen%3D1/file/seg.ts
`

export const KICK_MASTER = `#EXTM3U
#EXT-X-SESSION-DATA:DATA-ID="NET.LIVE-VIDEO.CONTENT.ID",VALUE="abc123"
#EXT-X-SESSION-DATA:DATA-ID="NET.LIVE-VIDEO.STREAM.ID",VALUE="def456"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1080p60",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=9010609,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="1080p60",FRAME-RATE=60.000
1080p60/playlist.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000
360p30/playlist.m3u8
`

export const KICK_MASTER_URL =
  'https://fa723fc1b171.us-west-2.playback.live-video.net/api/video/v1/us-west-2.196233775518.channel.abc.m3u8?token=x'

export const KICK_MEDIA = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:1601
#EXT-X-MAP:URI="init-0.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T13:20:00.000Z
#EXTINF:2.000,
1601.m4s
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T13:20:02.000Z
#EXTINF:2.000,
1602.m4s
`

export const TWITCH_VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.000,
0.ts
#EXTINF:10.000,
1-muted.ts
#EXTINF:4.500,
2.ts
#EXT-X-ENDLIST
`
