/**
 * Checks, against the real services, every third-party endpoint Regie depends on. Some are unofficial
 * (Twitch's web GraphQL, Kick's site API) and can change without notice: the daily workflow runs this and
 * opens an issue when one breaks. Exit code 1 when anything fails.
 */
import { searchKick, searchTwitch, twitchChannels } from '../src/platforms/directory.ts'
import { fetchTitle } from '../src/platforms/titles.ts'

type Check = [name: string, run: () => Promise<string | true>]

const ok = (condition: boolean, why: string): string | true => (condition ? true : why)

const checks: Check[] = [
  ['Twitch search (GraphQL, unofficial)', async () => ok((await searchTwitch('valorant')).length > 0, 'no result')],
  [
    'Twitch live status (GraphQL, unofficial)',
    async () =>
      ok(
        (await twitchChannels(['twitch'])).some((c) => c.id === 'twitch'),
        'channel "twitch" not found',
      ),
  ],
  ['Kick search (site API)', async () => ok((await searchKick('xqc')).length > 0, 'no result')],
  [
    'YouTube oEmbed title',
    async () => ok(Boolean(await fetchTitle({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' })), 'no title'),
  ],
  [
    'Twitch Embed JS',
    async () => {
      // Bun can't always decode Twitch's compressed reply: ask for it uncompressed.
      const response = await fetch('https://player.twitch.tv/js/embed/v1.js', {
        headers: { 'Accept-Encoding': 'identity' },
      })
      const text = await response.text()
      return ok(response.ok && text.includes('Player'), `HTTP ${response.status}`)
    },
  ],
  ['YouTube IFrame API', async () => ok((await fetch('https://www.youtube.com/iframe_api')).ok, 'not reachable')],
  [
    'Twitch chat socket (anonymous)',
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
        const timer = setTimeout(() => {
          socket.close()
          resolve('no welcome within 10 s')
        }, 10_000)
        socket.onopen = () => {
          socket.send('PASS SCHMOOPIIE')
          socket.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`)
        }
        socket.onmessage = (event) => {
          if (String(event.data).includes(' 001 ')) {
            clearTimeout(timer)
            socket.close()
            resolve(true)
          }
        }
        socket.onerror = () => resolve('connection error')
      }),
  ],
]

let failed = 0
const lines: string[] = []
for (const [name, run] of checks) {
  let result: string | true
  try {
    result = await run()
  } catch (error) {
    result = error instanceof Error ? error.message : String(error)
  }
  if (result !== true) failed++
  lines.push(`${result === true ? '✅' : '❌'} ${name}${result === true ? '' : `: ${result}`}`)
}
console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)
