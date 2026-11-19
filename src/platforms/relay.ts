import { healthUrl, parseHealth, type RelayHealth } from '../core/relay.ts'

/** Asks the viewer's relay whether it is up. Never throws: an unreachable relay is `null`, and the embeds play. */
export async function relayHealth(base: string, key: string): Promise<RelayHealth | null> {
  try {
    const response = await fetch(healthUrl(base, key), {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) return null
    return parseHealth(await response.json())
  } catch {
    return null
  }
}
