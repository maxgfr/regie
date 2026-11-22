/**
 * Runs first in the worker of Twitch's player on twitch.tv (put there by `twitch-site.ts`), before the
 * player's own code. It wraps the worker's `fetch`: the live master from usher passes through and is
 * remembered, and the media playlists of its variants come back ad-free (`relay/site.ts`). Segments and
 * everything else go to the network untouched. Any failure here hands the request back to the network:
 * an ad is better than a broken player.
 */
import { TwitchSite, usherLogin } from '../relay/site.ts'
import { Twitch } from '../relay/twitch.ts'

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const scope = self as unknown as { fetch: Fetch; __regieAds?: boolean }

if (!scope.__regieAds) {
  scope.__regieAds = true
  const network = scope.fetch.bind(scope)
  const log = (message: string) => console.debug(`[Regie] ${message}`)
  const site = new TwitchSite(new Twitch({ fetch: (url, init) => network(url, init), log }))

  const urlOf = (input: RequestInfo | URL): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  const playlist = (status: number, body: string) =>
    new Response(body, { status, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })

  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    try {
      url = urlOf(input)
    } catch {
      return network(input, init)
    }
    if (usherLogin(url)) {
      const response = await network(input, init)
      try {
        if (response.ok) site.master(url, await response.clone().text())
      } catch (error) {
        log(`master not read: ${error instanceof Error ? error.message : 'failed'}`)
      }
      return response
    }
    if (site.knows(url)) {
      try {
        const answer = await site.media(url)
        if (answer) return playlist(answer.status, answer.body)
      } catch (error) {
        log(`playlist left to the player: ${error instanceof Error ? error.message : 'failed'}`)
      }
    }
    return network(input, init)
  }
}
