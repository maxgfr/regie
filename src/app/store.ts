import { TypedEventTarget } from 'remix/component'
import { type ChatMessage, TwitchChat } from '../chat/irc.ts'
import { mixAudio } from '../core/audio.ts'
import { adblockSuspect, shouldWake, WAKE_AFTER_MS } from '../core/embed.ts'
import { failedReply } from '../core/extension-protocol.ts'
import {
  decayHype,
  type HypeState,
  initialHype,
  meter,
  recordMessage,
  spike,
  TAKEOVER_MS,
  TAKEOVER_SPIKE,
} from '../core/hype.ts'
import {
  EXTENSION_PLATFORMS,
  normalizeRelayBase,
  pickRelay,
  type RelayHealth,
  type RelayStatus,
  type RelayVia,
  relayable,
} from '../core/relay.ts'
import { decodeSession, defaultSession, encodeSession, newTile } from '../core/session.ts'
import { chatHold, planSync } from '../core/sync.ts'
import type { AudioMode, Capabilities, LayoutMode, Session, Source, Tile } from '../core/types.ts'
import { type Creator, kickChannel, twitchChannels } from '../platforms/directory.ts'
import { extension, extensionHealth } from '../platforms/extension.ts'
import { capabilities, sourceName } from '../platforms/parse.ts'
import { relayHealth } from '../platforms/relay.ts'
import { fetchTitle } from '../platforms/titles.ts'
import { createPlayer, type PlaybackState, type Player, type PlayerRelay, type QualityState } from '../players/index.ts'
import { canPlayWithSound } from '../players/load-script.ts'
import * as library from './library.ts'

export interface TileRuntime {
  state: PlaybackState
  hype: HypeState
  latency?: number
  /** The player has played at least once: before that, a pause is a refused autoplay. */
  played?: boolean
  /** When the player was mounted. */
  mountedAt?: number
  /**
   * When the player got its chance to start: mounted at a size it can autoplay at, or its turn in the line
   * check. Unset while it waits in the line-check queue. The "click to start" and "ad blocker" clocks run
   * from here, so a monitor still waiting for its turn isn't blamed for not starting.
   */
  chanceAt?: number
  /** A `play()` was already sent to a player that didn't start on its own. */
  retried?: boolean
  /** Since when the player has been paused (Twitch also sends a pause for a short rebuffer). */
  pausedAt?: number
  /** Last time Regie restarted a player that stopped on its own. */
  resumedAt?: number
  /** The current pause is the viewer's (they were inside the player): its sound isn't moved away. */
  pausedByViewer?: boolean
  /** Last `idle` the mix saw, to re-render when it changes. */
  idleSeen?: boolean
  /** Title from the platform's oEmbed, when it has one. */
  title?: string
  /** Live status, title, category and audience of a Twitch or Kick channel. */
  info?: Creator
  /** Clap time for sync, `performance.now()` ms. */
  mark?: number
  /** The qualities the current player can be switched to (an HLS one), and the one it plays. */
  quality?: QualityState
}

/** Players are other sites' code: a failing call must never break the control room. */
function safely<T>(call: () => T): T | undefined {
  try {
    return call()
  } catch {
    return undefined
  }
}

const LAYOUT_CYCLE: LayoutMode[] = ['grid', 'focus', 'theater']
/** A Twitch pause shorter than this is a rebuffer. */
const RESUME_AFTER_MS = 3000
/** A Twitch tile silent this long without the viewer asking gives its sound to one that plays. */
const IDLE_AFTER_MS = 3000
/** Between two attempts to restart the same player. */
const RESUME_EVERY_MS = 5000
const MAX_CHAT = 400
const FADE_MS = 600
/** At startup, how long players the relay could take wait for its first answer before mounting their embed. */
const RELAY_WAIT_MS = 1500
/** How often an unreachable relay (or a missing extension) is asked again. */
const RELAY_RETRY_MS = 30_000
/** `#relayTarget` of a tile playing through the Regie extension (a server target is an address). */
const EXTENSION_TARGET = 'extension'

type Events = { change: Event; chat: Event; tick: Event }

/** All state of the control room. Components subscribe to `change` (session/UI), `chat` and `tick` (meters). */
export class Store extends TypedEventTarget<Events> {
  session: Session = defaultSession()
  runtime = new Map<string, TileRuntime>()
  players = new Map<string, Player>()
  /** DOM order of the tiles: append-only, so a player's iframe never moves in the document. */
  domOrder: string[] = []
  ui = {
    selectedId: null as string | null,
    listenId: null as string | null,
    syncOpen: false,
    helpOpen: false,
    libraryOpen: false,
    libraryTab: 'search' as 'search' | 'favorites' | 'recent' | 'setups' | 'data',
    chatTab: 'merged' as string,
    soundAllowed: false,
    chatConnected: false,
    takeover: null as { id: string; until: number } | null,
    /** "Line check": a small Twitch monitor shown large for a moment, because Twitch only autoplays ≥ 400×300. */
    warmup: null as { id: string; since: number } | null,
    /** The mini control room (picture-in-picture window) is open: it plays the sound, the wall is silent. */
    miniRegie: false,
    /** The browser offered to install the app. */
    installable: false,
    /** Favourites that just went live and aren't on the wall. */
    liveAlerts: [] as Creator[],
    toast: null as string | null,
  }
  /**
   * The viewer's own relay (`bun run relay`), saved in this browser only: where it is and whether it answers.
   * `via`: the relay Twitch tiles play from now (the server when it is up, else the Regie extension when it
   * answers, else none). `extension`: the extension's version while it answers.
   */
  relay = {
    url: '',
    key: '',
    status: 'off' as RelayStatus,
    ytdlp: null as string | null,
    ffmpeg: null as string | null,
    via: null as RelayVia | null,
    extension: null as string | null,
  }
  chatLog: ChatMessage[] = []
  #pending: (ChatMessage & { release: number })[] = []
  #chat = new TwitchChat()
  #applied = new Map<string, number>()
  /** Players whose sound must be sent again as it is (they may have changed it themselves as they started playing). */
  #resend = new Set<string>()
  #fade: { from: Map<string, number>; to: Record<string, number>; start: number } | null = null
  #warmQueue: string[] = []
  #lastHash = ''
  #hashTimer: ReturnType<typeof setTimeout> | undefined
  #toastTimer: ReturnType<typeof setTimeout> | undefined
  #host = location.hostname || 'localhost'

  constructor() {
    super()
    this.#chat.onMessage = (message) => this.#queueChat(message)
    this.#chat.onStatus = (connected) => {
      this.ui.chatConnected = connected
      this.#emit('chat')
    }
  }

  // ----- lifecycle -----

  start() {
    // The players a relay could take wait for the relays' first answers: the server's, if one is set, and
    // the extension's, which may or may not be installed.
    this.#relayGate = true
    this.#relayGateTimer = setTimeout(() => this.#openGate(), RELAY_WAIT_MS)
    this.#gateWaits.add('extension')
    const relay = library.relaySettings()
    this.#useRelay(relay.url, relay.key, true)
    void this.#checkExtension()
    // Installed or enabled since the page loaded: ask it.
    extension()?.onHello(() => {
      if (!this.#extensionHealth && !this.#extensionChecking) void this.#checkExtension()
    })
    setInterval(() => {
      if (this.relay.status === 'down' && normalizeRelayBase(this.relay.url)) this.#checkRelay()
      if (!this.#extensionHealth && !this.#extensionChecking) void this.#checkExtension()
    }, RELAY_RETRY_MS)
    this.loadHash(location.hash)
    window.addEventListener('hashchange', () => {
      if (location.hash.replace(/^#/, '') !== this.#lastHash) this.loadHash(location.hash)
    })
    const unlock = () => {
      this.#resumeStalled()
      if (this.ui.soundAllowed || !canPlayWithSound()) return
      this.ui.soundAllowed = true
      this.#applyAudio(true)
      this.changed()
    }
    for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, unlock, { capture: true })
    // A click inside a player iframe also activates the page.
    window.addEventListener('blur', () => setTimeout(unlock, 50))
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.#wakeTimer)
      if (!document.hidden) this.#wakeTimer = setTimeout(() => this.#wake(), WAKE_AFTER_MS)
    })
    setInterval(() => this.#tick(), 1000)
    setInterval(() => this.#releaseChat(), 250)
    setInterval(() => this.refreshInfo(), 60_000)
    setInterval(() => this.watchFavorites(), 90_000)
    this.watchFavorites()
  }

  /** Base settings of a new session: the defaults, then what this browser saved last time. */
  #base(): Session {
    const base = defaultSession()
    const saved = library.preferences()
    const modes = ['solo', 'mix', 'manual']
    if (typeof saved.audioMode === 'string' && modes.includes(saved.audioMode)) base.audioMode = saved.audioMode
    if (saved.transition === 'cut' || saved.transition === 'mix') base.transition = saved.transition
    if (typeof saved.duck === 'number' && saved.duck >= 0 && saved.duck <= 1) base.duck = saved.duck
    for (const key of ['liveChat', 'antiSpoiler', 'autoDirector', 'chatOpen', 'autoAdd'] as const) {
      if (typeof saved[key] === 'boolean') base[key] = saved[key]
    }
    if (Array.isArray(saved.keywords)) base.keywords = saved.keywords.filter((w) => typeof w === 'string').slice(0, 20)
    return base
  }

  /** Favourites known to be live, to notice the ones that just started. Null until the first check. */
  #liveFavorites: Set<string> | null = null

  /**
   * Watches favourites: one that goes live is added to the wall (when "auto-add" is on) or offered in a notice,
   * with a system notification when Regie is in the background and notifications are allowed.
   */
  async watchFavorites() {
    const favorites = library.favorites().filter((f) => f.source.kind === 'live')
    const twitch = favorites.filter((f) => f.source.platform === 'twitch').map((f) => f.source.id)
    const kick = favorites
      .filter((f) => f.source.platform === 'kick')
      .map((f) => f.source.id)
      .slice(0, 8)
    const [found, kicks] = await Promise.all([twitchChannels(twitch), Promise.all(kick.map((id) => kickChannel(id)))])
    const live = [...found, ...kicks].filter((creator): creator is Creator => Boolean(creator?.live))
    const keys = new Set(live.map((creator) => `${creator.platform}:${creator.id}`))
    const previous = this.#liveFavorites
    this.#liveFavorites = keys
    if (!previous) return
    const onWall = (creator: Creator) =>
      this.session.tiles.some((tile) => tile.source.platform === creator.platform && tile.source.id === creator.id)
    const started = live.filter((creator) => !previous.has(`${creator.platform}:${creator.id}`) && !onWall(creator))
    if (!started.length) return
    for (const creator of started) {
      if (this.session.autoAdd && this.session.tiles.length < 16) {
        this.add({ platform: creator.platform, kind: 'live', id: creator.id })
        this.toast(`● ${creator.name}`)
      } else {
        this.ui.liveAlerts = [creator, ...this.ui.liveAlerts.filter((c) => c.id !== creator.id)].slice(0, 3)
      }
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(creator.name, {
            body: [creator.category, creator.title].filter(Boolean).join(' · '),
            icon: creator.avatar,
            tag: `regie-${creator.id}`,
          })
        } catch {
          // Notifications can be refused by the system.
        }
      }
    }
    this.#emit('change')
  }

  dismissAlert(creator: Creator, add: boolean) {
    this.ui.liveAlerts = this.ui.liveAlerts.filter((c) => !(c.id === creator.id && c.platform === creator.platform))
    if (add) this.add({ platform: creator.platform, kind: 'live', id: creator.id })
    else this.#emit('change')
  }

  setAutoAdd(on: boolean) {
    this.session.autoAdd = on
    this.changed()
  }

  /** Live status of the Twitch and Kick channels on the wall (anonymous public endpoints). */
  async refreshInfo() {
    const tiles = this.session.tiles.filter((tile) => tile.source.kind === 'live')
    const twitch = tiles.filter((tile) => tile.source.platform === 'twitch')
    const kick = tiles.filter((tile) => tile.source.platform === 'kick')
    const found = await twitchChannels(twitch.map((tile) => tile.source.id))
    for (const tile of twitch) {
      const runtime = this.runtime.get(tile.id)
      const info = found.find((creator) => creator.id === tile.source.id)
      if (runtime && info) runtime.info = info
    }
    await Promise.all(
      kick.map(async (tile) => {
        const info = await kickChannel(tile.source.id)
        const runtime = this.runtime.get(tile.id)
        if (runtime && info) runtime.info = info
      }),
    )
    this.#emit('change')
  }

  loadHash(hash: string) {
    for (const id of [...this.players.keys()]) this.#detach(id)
    this.#containers.clear()
    this.#fits.clear()
    this.#unfitted.clear()
    this.#blocked.clear()
    this.#relayFailed.clear()
    this.#deferred.clear()
    this.#warmQueue = []
    this.ui.warmup = null
    this.session = decodeSession(hash, this.#base())
    this.domOrder = this.session.tiles.map((tile) => tile.id)
    this.runtime.clear()
    for (const tile of this.session.tiles) this.runtime.set(tile.id, this.#newRuntime(tile))
    this.#lastHash = encodeSession(this.session)
    this.#syncChat()
    this.changed(false)
    this.refreshInfo()
  }

  #newRuntime(tile: Tile): TileRuntime {
    const now = Date.now()
    const runtime: TileRuntime = { state: 'loading', hype: initialHype(now) }
    fetchTitle(tile.source).then((title) => {
      if (!title || this.runtime.get(tile.id) !== runtime) return
      runtime.title = title
      this.#emit('change')
    })
    return runtime
  }

  /** The label of a tile: its title when known, else its channel name or id. */
  label(id: string): string {
    const tile = this.tile(id)
    if (!tile) return ''
    const runtime = this.runtime.get(id)
    return runtime?.title ?? runtime?.info?.name ?? sourceName(tile.source)
  }

  #emit(type: keyof Events) {
    this.dispatchEvent(new Event(type))
  }

  /** Call after any change: re-renders, re-mixes audio, and saves the session in the URL. */
  changed(persist = true) {
    this.#applyAudio()
    this.#emit('change')
    if (!persist) return
    clearTimeout(this.#hashTimer)
    this.#hashTimer = setTimeout(() => {
      const hash = encodeSession(this.session)
      if (hash === this.#lastHash) return
      this.#lastHash = hash
      history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search)
      library.savePreferences(this.session)
    }, 250)
  }

  toast(message: string) {
    this.ui.toast = message
    clearTimeout(this.#toastTimer)
    this.#toastTimer = setTimeout(() => {
      this.ui.toast = null
      this.#emit('change')
    }, 3200)
    this.#emit('change')
  }

  tile(id: string | null): Tile | undefined {
    return this.session.tiles.find((tile) => tile.id === id)
  }

  // ----- players -----

  /** Mounts the player of a tile into its screen element. Called once per tile by the stage. */
  /** Where each player is mounted, to mount it again on a reload. */
  #containers = new Map<string, HTMLElement>()
  /** Tiles shown below the size Twitch needs in the current layout, boosts aside (kept by the stage). */
  #small = new Set<string>()
  /** Tiles currently suspected of being blocked by the viewer's ad blocker (to re-render on change). */
  #blocked = new Set<string>()

  attach(id: string, container: HTMLElement) {
    const tile = this.tile(id)
    if (!tile || this.players.has(id)) return
    this.#containers.set(id, container)
    // Mounting the embed now would mean reloading it in a moment if the relay answers.
    if (this.#relayGate && this.#awaitsRelay(tile.source)) {
      this.#deferred.add(id)
      return
    }
    const target = this.#relayTarget(tile)
    // A new player reports its own qualities; the viewer's choice is applied to it once it has.
    const mounting = this.runtime.get(id)
    if (mounting) mounting.quality = undefined
    this.#qualityApplied.delete(id)
    const player = createPlayer({
      source: tile.source,
      container,
      host: this.#host,
      initialVolume: this.ui.soundAllowed ? (this.#targetVolumes()[id] ?? 0) : 0,
      relay: target
        ? // `onFail` is called from the player's own callbacks: it is replaced once they have returned.
          this.#playerRelay(target, () => setTimeout(() => this.#fallBack(id, player), 0))
        : undefined,
      events: {
        state: (state, byPlayer) => {
          const runtime = this.runtime.get(id)
          if (!runtime) return
          runtime.state = state
          // A relayed stream that stops for good may mean the relay itself is gone: ask it again, and if it
          // doesn't answer, the official players take over.
          if (state === 'offline' && this.#relayed.has(id)) this.#recheck(this.#relayed.get(id))
          runtime.pausedAt = state === 'paused' ? (runtime.pausedAt ?? Date.now()) : undefined
          if (state === 'paused') {
            // Clicking inside a player moves the focus into its iframe: a pause from there is the viewer's.
            runtime.pausedByViewer ||= this.#containers.get(id)?.contains(document.activeElement) ?? false
          } else runtime.pausedByViewer = false
          if (state === 'playing') {
            this.#resend.add(id)
            if (!runtime.played && this.ui.warmup?.id === id) setTimeout(() => this.#nextWarmup(id), 1200)
            runtime.played = true
          }
          // Playing or paused, the mix may change: a player that plays again gets its sound sent again.
          if (state === 'playing' || (state === 'paused' && runtime.played)) this.changed(false)
          else this.#emit('change')
        },
        latency: (seconds) => {
          const runtime = this.runtime.get(id)
          if (!runtime) return
          // Through the relay, the latency is measured where the video plays, Regie's own delay included.
          const delay = this.#relayed.has(id) ? (this.tile(id)?.delay ?? 0) : 0
          runtime.latency = Math.max(0, seconds - delay)
        },
        userVolume: (volume, muted) => this.#fromPlayer(id, volume, muted),
        quality: (state) => this.#onQuality(id, state),
      },
    })
    if (player) {
      this.players.set(id, player)
      if (target) this.#relayed.set(id, target)
      this.#applied.set(id, 0)
      const runtime = this.runtime.get(id)
      if (runtime) {
        runtime.mountedAt = Date.now()
        runtime.chanceAt = runtime.mountedAt
      }
      // A player mounted again (reload) starts on automatic quality: give it its size.
      if (this.#fits.has(id)) {
        this.#unfitted.add(id)
        if (!this.ui.warmup && !this.#warmQueue.length) this.#applyFits()
      }
    }
  }

  /**
   * Twitch refuses to autoplay a player shown below 400×300, but one that started keeps playing once it is
   * made smaller. So each small Twitch monitor is shown on the main monitor for a moment until it plays: a
   * line check, as when a control room powers up its monitors.
   */
  /** The stage tells which tiles are too small for Twitch in its layout (boosts aside). */
  setSmallTiles(ids: Set<string>) {
    this.#small = ids
  }

  isSmall(id: string): boolean {
    return this.#small.has(id)
  }

  warmUp(id: string) {
    const runtime = this.runtime.get(id)
    if (
      !runtime ||
      !this.embedTwitch(id) ||
      runtime.played ||
      this.#warmQueue.includes(id) ||
      this.ui.warmup?.id === id
    )
      return
    this.#warmQueue.push(id)
    runtime.chanceAt = undefined
    if (!this.ui.warmup) this.#nextWarmup()
  }

  warmupProgress(): { done: number; total: number } {
    const pending = this.#warmQueue.length + (this.ui.warmup ? 1 : 0)
    this.#warmTotal = Math.max(this.#warmTotal, pending)
    return { done: this.#warmTotal - pending + 1, total: this.#warmTotal }
  }

  #warmTotal = 0
  #warmTimer: ReturnType<typeof setTimeout> | undefined

  #nextWarmup(finished?: string) {
    if (finished && this.ui.warmup?.id !== finished) return
    // Wait while a monitor that is already large is still starting: taking its place would shrink it
    // before it plays, and Twitch would refuse it too.
    const now = Date.now()
    const starting = this.session.tiles.some((tile) => {
      const runtime = this.runtime.get(tile.id)
      return (
        this.embedTwitch(tile.id) &&
        tile.id !== finished &&
        tile.id !== this.ui.warmup?.id &&
        runtime?.chanceAt !== undefined &&
        !runtime.played &&
        now - runtime.chanceAt < 7000
      )
    })
    if (starting) {
      this.ui.warmup = null
      clearTimeout(this.#warmTimer)
      this.#warmTimer = setTimeout(() => this.#nextWarmup(), 1000)
      return
    }
    let next = this.#warmQueue.shift()
    while (next) {
      const runtime = this.runtime.get(next)
      if (runtime && !runtime.played && this.tile(next)) break
      next = this.#warmQueue.shift()
    }
    this.ui.warmup = next ? { id: next, since: now } : null
    if (!next) this.#applyFits()
    const turn = next ? this.runtime.get(next) : undefined
    if (turn) turn.chanceAt = now
    if (!next) this.#warmTotal = 0
    this.#emit('change')
  }

  /**
   * The viewer changed the sound inside a player. Regie follows instead of fighting it: muting there mutes the
   * tile; turning up a silent tile puts it on air (solo) or unmutes it (blend, manual); a new level is kept.
   */
  #fromPlayer(id: string, volume: number, muted: boolean) {
    const tile = this.tile(id)
    if (!tile) return
    const onAir = this.mix().onAir === id
    if (muted) {
      if (!onAir && this.session.audioMode === 'solo') return
      tile.muted = true
    } else {
      tile.muted = false
      if (volume > 0) tile.volume = Math.round(volume * 100) / 100
      if (!onAir && this.session.audioMode === 'solo') {
        this.session.audioId = id
        this.ui.takeover = null
      }
    }
    // The player already sounds the way the viewer wants: record it rather than send it back.
    this.#applied.set(id, this.mix().volumes[id] ?? 0)
    this.changed()
  }

  /** Destroys a tile's player and mounts a fresh one in the same container: the tile's node never moves. */
  #remount(id: string) {
    const container = this.#containers.get(id)
    const runtime = this.runtime.get(id)
    if (!container || !runtime) return
    this.#detach(id)
    runtime.played = false
    runtime.retried = false
    runtime.latency = undefined
    runtime.state = 'loading'
    // A fresh player starts where its platform starts it: Regie's delay is gone.
    const tile = this.tile(id)
    if (tile) tile.delay = 0
    this.attach(id, container)
    // A small monitor needs its line check again to start (Twitch only autoplays large players).
    if (this.#small.has(id)) this.warmUp(id)
  }

  // ----- relay -----

  /** Tiles playing through the relay, with the relay they were mounted on (`#relayTarget`). */
  #relayed = new Map<string, string>()
  /** Tiles whose stream didn't start on the relay: they keep their official player. */
  #relayFailed = new Set<string>()
  /** At startup, the players a relay could take wait for the relays' first answers (`RELAY_WAIT_MS` at most). */
  #relayGate = false
  #relayGateTimer: ReturnType<typeof setTimeout> | undefined
  /** The relays whose first answer the gate still waits for. */
  #gateWaits = new Set<RelayVia>()
  #deferred = new Set<string>()
  /** Only the latest health check counts. */
  #relayCheck = 0
  /** The server relay's last `/health`, while it is up. */
  #serverHealth: RelayHealth | null = null
  /** The extension's last `/health`, while it answers. */
  #extensionHealth: RelayHealth | null = null
  #extensionCheck = 0
  #extensionChecking = false

  /** Changes the relay settings (help sheet) and asks the new relay. */
  setRelay(url: string, key: string) {
    const nextKey = key.trim()
    const nextUrl = normalizeRelayBase(url) ?? url.trim()
    if (nextUrl === this.relay.url && nextKey === this.relay.key) return
    library.saveRelay(nextUrl, nextKey)
    this.#relayFailed.clear()
    this.#useRelay(nextUrl, nextKey, false)
  }

  /** Reads the relay settings again, after a backup was imported. */
  loadRelaySettings() {
    const { url, key } = library.relaySettings()
    if (url === this.relay.url && key === this.relay.key) return
    this.#relayFailed.clear()
    this.#useRelay(url, key, false)
  }

  /** A Twitch tile on its official embed: it needs 400×300 and a line check. */
  embedTwitch(id: string): boolean {
    return this.tile(id)?.source.platform === 'twitch' && !this.#relayed.has(id) && !this.#deferred.has(id)
  }

  /** The tile plays through the viewer's relay (or the extension). */
  relayed(id: string): boolean {
    return this.#relayed.has(id)
  }

  /** Which relay the tile plays through, or null for its official player. */
  relayedVia(id: string): RelayVia | null {
    const target = this.#relayed.get(id)
    if (target === undefined) return null
    return target === EXTENSION_TARGET ? 'extension' : 'server'
  }

  /** What Regie can do with a tile's player, which depends on whether it plays through the relay. */
  caps(tile: Tile): Capabilities {
    return capabilities(tile.source, this.#relayed.has(tile.id))
  }

  #useRelay(url: string, key: string, startup: boolean) {
    this.relay = { ...this.relay, url, key, status: 'off', ytdlp: null, ffmpeg: null }
    this.#serverHealth = null
    this.#relayCheck++
    if (startup && !url) return
    if (!url || normalizeRelayBase(url) === null) {
      this.relay.status = url ? 'down' : 'off'
      this.#settleRelay()
      return
    }
    this.relay.status = 'checking'
    if (startup) this.#gateWaits.add('server')
    this.#emit('change')
    this.#checkRelay()
  }

  async #checkRelay() {
    const base = normalizeRelayBase(this.relay.url)
    if (!base) return
    const token = ++this.#relayCheck
    const health = await relayHealth(base, this.relay.key)
    if (token !== this.#relayCheck) return
    const status: RelayStatus = health ? 'up' : 'down'
    if (status === this.relay.status && !this.#gateWaits.has('server')) return
    this.relay.status = status
    this.relay.ytdlp = health?.ytdlp ?? null
    this.relay.ffmpeg = health?.ffmpeg ?? null
    this.#serverHealth = health
    this.#settleRelay('server')
  }

  /**
   * Asks the Regie extension (`src/platforms/extension.ts`). It is there when its bridge says hello and its
   * service worker answers `/health`; an extension reloaded since the page loaded answers no more (status 0).
   */
  async #checkExtension() {
    const token = ++this.#extensionCheck
    this.#extensionChecking = true
    const health = await extensionHealth()
    if (token !== this.#extensionCheck) return
    this.#extensionChecking = false
    const was = this.#extensionHealth !== null
    this.#extensionHealth = health
    this.relay.extension = health ? (extension()?.version ?? '') : null
    if (was === (health !== null) && !this.#gateWaits.has('extension')) return
    this.#settleRelay('extension')
  }

  /** A relayed tile failed: ask the relay it played from again, so the other tiles leave it if it is gone. */
  #recheck(target: string | undefined) {
    if (target === EXTENSION_TARGET) {
      if (!this.#extensionChecking) void this.#checkExtension()
    } else if (target && this.relay.status === 'up') this.#checkRelay()
  }

  /**
   * A relay answered (or was turned off): only the tiles it changes are mounted again, once. At startup,
   * nothing mounts until every relay that could take a waiting tile has answered.
   */
  #settleRelay(answered?: RelayVia) {
    if (answered) this.#gateWaits.delete(answered)
    this.relay.via = this.relay.status === 'up' ? 'server' : this.#extensionHealth ? 'extension' : null
    if (this.#relayGate && this.#gateHolds()) {
      this.#emit('change')
      return
    }
    this.#openGate()
    for (const id of [...this.players.keys()]) {
      const tile = this.tile(id)
      if (tile && (this.#relayed.get(id) ?? '') !== this.#relayTarget(tile)) this.#remount(id)
    }
    this.changed(false)
  }

  /** A relay still to answer could change where a waiting tile plays. A server that is up wins anyway. */
  #gateHolds(): boolean {
    if (this.#gateWaits.has('server')) return true
    return this.#gateWaits.has('extension') && this.relay.status !== 'up'
  }

  /** While the gate is closed, whether a tile waits: a relay still to answer could play it. */
  #awaitsRelay(source: Source): boolean {
    if (this.#gateWaits.has('server') && relayable(source)) return true
    if (!this.#gateWaits.has('extension') || this.relay.status === 'up') return false
    return relayable(source, false, EXTENSION_PLATFORMS)
  }

  /**
   * The relay a tile should play from: the server's address and key, `EXTENSION_TARGET`, or '' for its
   * official player.
   */
  #relayTarget(tile: Tile): string {
    if (this.#relayFailed.has(tile.id)) return ''
    const base = normalizeRelayBase(this.relay.url)
    const server = this.relay.status === 'up' && base ? this.#serverHealth : null
    const via = pickRelay(tile.source, { server, extension: this.#extensionHealth })
    if (via === 'server') return `${base}#${this.relay.key}`
    return via === 'extension' ? EXTENSION_TARGET : ''
  }

  /** What a player needs to play from a relay target. */
  #playerRelay(target: string, onFail: () => void): PlayerRelay {
    if (target === EXTENSION_TARGET) {
      return {
        kind: 'extension',
        remux: false,
        platforms: this.#extensionHealth?.platforms ?? EXTENSION_PLATFORMS,
        onFail,
        load: (path, timeoutMs) => extension()?.fetch(path, { timeoutMs }) ?? Promise.resolve(failedReply()),
      }
    }
    return {
      kind: 'server',
      base: normalizeRelayBase(this.relay.url) ?? '',
      key: this.relay.key,
      remux: this.relay.ffmpeg !== null,
      platforms: this.#serverHealth?.platforms ?? null,
      onFail,
    }
  }

  /** Mounts the players that waited for the relay's first answer. */
  #openGate() {
    if (!this.#relayGate) return
    this.#relayGate = false
    this.#gateWaits.clear()
    clearTimeout(this.#relayGateTimer)
    for (const id of [...this.#deferred]) {
      this.#deferred.delete(id)
      const container = this.#containers.get(id)
      if (!container || !this.tile(id) || this.players.has(id)) continue
      this.attach(id, container)
      if (this.#small.has(id)) this.warmUp(id)
    }
    this.changed(false)
  }

  /** The stream never started on the relay: the tile gets its official player, in the same container. */
  #fallBack(id: string, player: Player | null) {
    if (!player || this.players.get(id) !== player) return
    const target = this.#relayed.get(id)
    this.#relayFailed.add(id)
    this.#remount(id)
    this.changed(false)
    this.#recheck(target)
  }

  /** The size each tile is shown at, and the tiles whose player hasn't been told yet. */
  #fits = new Map<string, { height: number; large: boolean }>()
  #unfitted = new Set<string>()

  /**
   * Matches a player's stream quality to the size it is shown at (Twitch). Held during line checks: each
   * one reshuffles the wall, and every quality change makes a player rebuffer.
   */
  fitPlayer(id: string, displayHeight: number, large: boolean) {
    this.#fits.set(id, { height: displayHeight, large })
    this.#unfitted.add(id)
    if (!this.ui.warmup && !this.#warmQueue.length) this.#applyFits()
  }

  #applyFits() {
    for (const id of this.#unfitted) {
      const player = this.players.get(id)
      const fit = this.#fits.get(id)
      if (player?.fit && fit) safely(() => player.fit?.(fit.height, fit.large))
    }
    this.#unfitted.clear()
  }

  /**
   * The quality the viewer picked for each tile, by label (`720p60`): a player mounted again (relay change,
   * reload) numbers its levels its own way. Kept for this visit only, never in the link.
   */
  #qualityChoice = new Map<string, string>()
  /** Tiles whose current player already got the viewer's choice. */
  #qualityApplied = new Set<string>()

  #onQuality(id: string, state: QualityState) {
    const runtime = this.runtime.get(id)
    if (!runtime) return
    runtime.quality = state
    if (!state.levels.length) return
    // A new player (a remount) first gets the viewer's choice back; after that, whatever the viewer picks in
    // the player's own menu becomes the choice.
    if (!this.#qualityApplied.has(id)) {
      this.#qualityApplied.add(id)
      const choice = this.#qualityChoice.get(id)
      const level = state.levels.find((candidate) => candidate.label === choice)
      const player = this.players.get(id)
      if (level && state.selected === null && player?.setQuality) {
        safely(() => player.setQuality?.(level.id))
        return
      }
    }
    const label = state.levels.find((level) => level.id === state.selected)?.label
    if (label) this.#qualityChoice.set(id, label)
    else this.#qualityChoice.delete(id)
  }

  /** Players that never started (autoplay refused) get another go on the next user gesture. */
  #resumeStalled() {
    for (const [id, player] of this.players) {
      const runtime = this.runtime.get(id)
      if (runtime && !runtime.played && runtime.state !== 'offline') safely(() => player.play())
    }
  }

  #forget(id: string) {
    this.#containers.delete(id)
    this.#relayFailed.delete(id)
    this.#deferred.delete(id)
    this.#fits.delete(id)
    this.#unfitted.delete(id)
    this.#qualityChoice.delete(id)
    this.#qualityApplied.delete(id)
  }

  #detach(id: string) {
    const player = this.players.get(id)
    if (player) safely(() => player.destroy())
    this.players.delete(id)
    this.#relayed.delete(id)
    this.#applied.delete(id)
    this.#resend.delete(id)
  }

  // ----- sources -----

  add(source: Source) {
    if (this.session.tiles.length >= 16) {
      this.toast('toast.full')
      return
    }
    const tile = newTile(source)
    this.session.tiles.push(tile)
    this.domOrder.push(tile.id)
    this.runtime.set(tile.id, this.#newRuntime(tile))
    if (!this.session.focusId) this.session.focusId = tile.id
    if (!this.session.audioId) this.session.audioId = tile.id
    if (this.session.tiles.length === 5 && this.session.layout === 'grid') this.session.layout = 'focus'
    this.ui.selectedId = tile.id
    library.rememberRecent(source, sourceName(source))
    this.#syncChat()
    this.changed()
    if (source.kind === 'live' && (source.platform === 'twitch' || source.platform === 'kick')) this.refreshInfo()
  }

  addMany(sources: Source[]) {
    for (const source of sources) this.add(source)
  }

  remove(id: string) {
    this.#detach(id)
    this.#forget(id)
    this.#warmQueue = this.#warmQueue.filter((other) => other !== id)
    if (this.ui.warmup?.id === id) this.#nextWarmup(id)
    this.session.tiles = this.session.tiles.filter((tile) => tile.id !== id)
    this.domOrder = this.domOrder.filter((other) => other !== id)
    this.runtime.delete(id)
    const first = this.session.tiles[0]?.id ?? null
    if (this.session.focusId === id) this.session.focusId = first
    if (this.session.audioId === id) this.session.audioId = first
    if (this.ui.selectedId === id) this.ui.selectedId = null
    this.#syncChat()
    this.changed()
  }

  clear() {
    for (const id of [...this.players.keys()]) this.#detach(id)
    this.#containers.clear()
    this.#fits.clear()
    this.#unfitted.clear()
    this.#blocked.clear()
    this.#relayFailed.clear()
    this.#deferred.clear()
    this.#warmQueue = []
    this.ui.warmup = null
    this.session = { ...this.#base(), master: this.session.master }
    this.domOrder = []
    this.runtime.clear()
    this.chatLog = []
    this.#syncChat()
    this.changed()
  }

  /** Swaps two tiles in the layout. The DOM order stays the same, so neither player reloads. */
  swap(a: string, b: string) {
    const tiles = this.session.tiles
    const i = tiles.findIndex((tile) => tile.id === a)
    const j = tiles.findIndex((tile) => tile.id === b)
    if (i < 0 || j < 0 || i === j) return
    ;[tiles[i], tiles[j]] = [tiles[j] as Tile, tiles[i] as Tile]
    this.changed()
  }

  // ----- program / main -----

  onAir(id: string) {
    if (!this.tile(id)) return
    this.session.audioId = id
    this.ui.takeover = null
    const tile = this.tile(id)
    if (tile?.muted) tile.muted = false
    this.changed()
  }

  setMain(id: string) {
    if (!this.tile(id)) return
    this.session.focusId = id
    if (this.session.layout === 'grid') this.session.layout = 'focus'
    this.changed()
  }

  setLayout(layout: LayoutMode) {
    this.session.layout = layout
    this.changed()
  }

  cycleLayout() {
    const index = LAYOUT_CYCLE.indexOf(this.session.layout)
    this.setLayout(LAYOUT_CYCLE[(index + 1) % LAYOUT_CYCLE.length] as LayoutMode)
  }

  select(id: string | null) {
    if (this.ui.selectedId === id) return
    this.ui.selectedId = id
    this.#emit('change')
  }

  listen(id: string | null) {
    if (this.ui.listenId === id) return
    this.ui.listenId = id
    this.changed(false)
  }

  // ----- audio -----

  setAudioMode(mode: AudioMode) {
    this.session.audioMode = mode
    this.changed()
  }

  setTransition(transition: 'cut' | 'mix') {
    this.session.transition = transition
    this.changed()
  }

  setVolume(id: string, volume: number) {
    const tile = this.tile(id)
    if (!tile) return
    tile.volume = Math.min(1, Math.max(0, volume))
    if (tile.volume > 0) tile.muted = false
    this.changed()
  }

  toggleMute(id: string) {
    const tile = this.tile(id)
    if (!tile) return
    tile.muted = !tile.muted
    this.changed()
  }

  setMaster(value: number) {
    this.session.master = Math.min(1, Math.max(0, value))
    this.changed()
  }

  setDuck(value: number) {
    this.session.duck = Math.min(1, Math.max(0, value))
    this.changed()
  }

  /** The tile on air after takeovers, stopped players and the "listen" key, and whether it covers one. */
  mix() {
    const now = Date.now()
    const takeover = this.ui.takeover && this.ui.takeover.until > now ? this.ui.takeover.id : null
    return mixAudio({
      tiles: this.session.tiles.map((tile) => {
        const runtime = this.runtime.get(tile.id)
        return {
          id: tile.id,
          volume: tile.volume,
          muted: tile.muted,
          hype: runtime ? spike(runtime.hype, now) : 0,
          idle: this.#idle(tile, runtime, now),
        }
      }),
      mode: this.session.audioMode,
      audioId: this.session.audioId,
      listenId: this.ui.listenId ?? takeover,
      duck: this.session.duck,
      master: this.session.master,
    })
  }

  /**
   * A Twitch tile that makes no sound although the viewer didn't ask for it: not started yet (autoplay refused,
   * a content warning), offline, or stopped by Twitch itself for a few seconds (a refused restart). Its sound
   * goes to a stream that plays. Wall paused with Regie's key: nothing moves.
   */
  #idle(tile: Tile, runtime: TileRuntime | undefined, now: number): boolean {
    if (!runtime || !this.embedTwitch(tile.id) || this.#holding) return false
    if (runtime.state === 'offline' || runtime.state === 'ended') return true
    if (!runtime.played) return runtime.chanceAt !== undefined && now - runtime.chanceAt >= IDLE_AFTER_MS
    return (
      runtime.state === 'paused' &&
      !runtime.pausedByViewer &&
      runtime.pausedAt !== undefined &&
      now - runtime.pausedAt >= IDLE_AFTER_MS
    )
  }

  #targetVolumes(): Record<string, number> {
    return this.mix().volumes
  }

  /**
   * The tile to show large for a while, if any: the one in a line check, when it is below the size Twitch
   * needs (`small`).
   */
  boostCandidate(small: (id: string) => boolean): string | null {
    return this.ui.warmup && small(this.ui.warmup.id) ? this.ui.warmup.id : null
  }

  setMiniRegie(open: boolean) {
    this.ui.miniRegie = open
    this.changed(false)
  }

  #applyAudio(immediate = false) {
    const target = this.ui.soundAllowed && !this.ui.miniRegie ? this.#targetVolumes() : {}
    // Sent again as it is, without a fade: a fade from silence would dip the sound at every rebuffer.
    for (const id of this.#resend) {
      const player = this.players.get(id)
      const volume = this.#fade?.to[id] ?? target[id] ?? 0
      if (player) {
        this.#applied.set(id, volume)
        safely(() => player.setVolume(volume))
      }
    }
    this.#resend.clear()
    const changed = [...this.players.keys()].some((id) => (this.#applied.get(id) ?? 0) !== (target[id] ?? 0))
    if (!changed) return
    if (this.session.transition === 'mix' && !immediate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.#fade = { from: new Map(this.#applied), to: target, start: performance.now() }
      this.#stepFade()
      return
    }
    this.#fade = null
    for (const [id, player] of this.players) this.#setVolume(id, player, target[id] ?? 0)
  }

  #setVolume(id: string, player: Player, volume: number) {
    if (this.#applied.get(id) === volume) return
    this.#applied.set(id, volume)
    safely(() => player.setVolume(volume))
  }

  #stepFade = () => {
    const fade = this.#fade
    if (!fade) return
    const progress = Math.min(1, (performance.now() - fade.start) / FADE_MS)
    const eased = 1 - (1 - progress) ** 3
    for (const [id, player] of this.players) {
      const from = fade.from.get(id) ?? 0
      const to = fade.to[id] ?? 0
      if (from === to) continue
      // Players that can only mute (Kick) switch once, at the end, instead of reloading on every step.
      const tile = this.tile(id)
      if (!tile || !this.caps(tile).volume) {
        if (progress === 1) this.#setVolume(id, player, to)
        continue
      }
      this.#setVolume(id, player, Math.round((from + (to - from) * eased) * 100) / 100)
    }
    if (progress < 1) setTimeout(this.#stepFade, 50)
    else this.#fade = null
  }

  /** The viewer paused the wall with Regie's own key: nothing is restarted behind their back. */
  #holding = false

  playAll() {
    this.#holding = false
    for (const player of this.players.values()) safely(() => player.play())
  }

  pauseAll() {
    this.#holding = true
    for (const player of this.players.values()) safely(() => player.pause())
  }

  /**
   * Twitch pauses a player it can't see: another window or tab in front, another monitor in full screen, a
   * moment of layout change. Nothing would start it again, so a Twitch player that has played and has been
   * paused for a few seconds is restarted once it can be seen again, unless the viewer paused the wall.
   */
  #resumePaused(now: number) {
    if (this.#holding || document.hidden) return
    for (const [id, runtime] of this.runtime) {
      if (runtime.state !== 'paused' || !runtime.played || runtime.pausedAt === undefined) continue
      if (now - runtime.pausedAt < RESUME_AFTER_MS) continue
      this.#restart(id, runtime, now)
    }
  }

  #wakeTimer: ReturnType<typeof setTimeout> | undefined

  /** Back on the page: each player Twitch stopped in the background gets one `play()` (see `shouldWake`). */
  #wake() {
    if (this.#holding || document.hidden) return
    const now = Date.now()
    for (const [id, runtime] of this.runtime) {
      const { played, state, pausedByViewer } = runtime
      if (shouldWake({ played, state, pausedByViewer })) this.#restart(id, runtime, now)
    }
  }

  /** One `play()` to an official Twitch player that stopped on its own, if it can be seen and wasn't just sent one. */
  #restart(id: string, runtime: TileRuntime, now: number) {
    if (now - (runtime.resumedAt ?? 0) < RESUME_EVERY_MS || !this.embedTwitch(id)) return
    const container = this.#containers.get(id)
    const fullscreen = document.fullscreenElement
    if (fullscreen && container && !fullscreen.contains(container)) return
    const player = this.players.get(id)
    if (!player) return
    runtime.resumedAt = now
    safely(() => player.play())
  }

  /** Moves every seekable tile by the same amount, keeping their offsets (multi-POV replays). */
  seekAll(seconds: number) {
    for (const player of this.players.values()) safely(() => player.seekBy(seconds))
  }

  // ----- sync -----

  openSync(open: boolean) {
    this.ui.syncOpen = open
    if (!open) for (const runtime of this.runtime.values()) runtime.mark = undefined
    this.#emit('change')
  }

  clap(id: string) {
    const runtime = this.runtime.get(id)
    if (!runtime || !this.ui.syncOpen) return
    runtime.mark = performance.now()
    this.#emit('change')
  }

  marks(): number {
    return [...this.runtime.values()].filter((runtime) => runtime.mark !== undefined).length
  }

  applySync() {
    const plan = planSync(
      this.session.tiles.map((tile) => ({
        id: tile.id,
        mark: this.runtime.get(tile.id)?.mark,
        canDelay: this.caps(tile).seek && this.players.has(tile.id),
        delay: tile.delay,
      })),
    )
    for (const tile of this.session.tiles) {
      const next = plan.delays[tile.id] ?? tile.delay
      const diff = next - tile.delay
      if (diff !== 0 && safely(() => this.players.get(tile.id)?.seekBy(-diff))) tile.delay = next
      if (this.runtime.get(tile.id)?.mark !== undefined) tile.ahead = plan.ahead[tile.id] ?? 0
    }
    this.openSync(false)
    this.toast('toast.synced')
    this.changed()
  }

  resetSync() {
    for (const tile of this.session.tiles) {
      if (tile.delay) safely(() => this.players.get(tile.id)?.seekBy(tile.delay))
      tile.delay = 0
      tile.ahead = 0
    }
    this.openSync(false)
    this.changed()
  }

  /** Fine adjustment of one tile's delay, ±0.25 s. */
  nudge(id: string, seconds: number) {
    const tile = this.tile(id)
    if (!tile) return
    const next = Math.max(0, Math.round((tile.delay + seconds) * 100) / 100)
    if (this.caps(tile).seek && safely(() => this.players.get(tile.id)?.seekBy(-(next - tile.delay)))) {
      tile.delay = next
    } else {
      // A stream Regie cannot seek only records its lead, which holds its chat back.
      tile.ahead = Math.round((tile.ahead - seconds) * 100) / 100
    }
    this.changed()
  }

  // ----- chat -----

  setLiveChat(on: boolean) {
    this.session.liveChat = on
    if (!on) {
      this.chatLog = []
      this.#pending = []
    }
    this.ui.chatTab = on ? 'merged' : (this.chatTiles()[0]?.id ?? 'merged')
    this.#syncChat()
    this.changed()
  }

  setAntiSpoiler(on: boolean) {
    this.session.antiSpoiler = on
    this.changed()
  }

  setKeywords(text: string) {
    this.session.keywords = text
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 20)
    this.changed()
  }

  toggleChat(open = !this.session.chatOpen) {
    this.session.chatOpen = open
    if (open && this.ui.chatTab !== 'merged' && !this.tile(this.ui.chatTab)) {
      this.ui.chatTab = this.session.liveChat ? 'merged' : (this.chatTiles()[0]?.id ?? 'merged')
    }
    this.changed()
  }

  setChatTab(tab: string) {
    this.ui.chatTab = tab
    this.#emit('change')
  }

  setAutoDirector(on: boolean) {
    this.session.autoDirector = on
    if (!on) this.ui.takeover = null
    this.changed()
  }

  chatTiles(): Tile[] {
    return this.session.tiles.filter((tile) => this.caps(tile).chat)
  }

  twitchTile(channel: string): Tile | undefined {
    return this.session.tiles.find(
      (tile) => tile.source.platform === 'twitch' && tile.source.kind === 'live' && tile.source.id === channel,
    )
  }

  #syncChat() {
    const channels = this.session.liveChat
      ? this.session.tiles.filter((tile) => this.caps(tile).liveChat).map((tile) => tile.source.id)
      : []
    this.#chat.setChannels(channels)
  }

  #queueChat(message: ChatMessage) {
    const tile = this.twitchTile(message.channel)
    if (!tile) return
    const hold = this.session.antiSpoiler ? chatHold(this.runtime.get(tile.id)?.latency, tile.delay, tile.ahead) : 0
    this.#pending.push({ ...message, release: message.at + hold * 1000 })
    if (this.#pending.length > 2000) this.#pending.splice(0, this.#pending.length - 2000)
  }

  #releaseChat() {
    if (!this.#pending.length) return
    const now = Date.now()
    const ready = this.#pending.filter((message) => message.release <= now)
    if (!ready.length) return
    this.#pending = this.#pending.filter((message) => message.release > now)
    for (const message of ready) {
      const tile = this.twitchTile(message.channel)
      const runtime = tile && this.runtime.get(tile.id)
      if (runtime) runtime.hype = recordMessage(runtime.hype, now)
    }
    this.chatLog.push(...ready)
    if (this.chatLog.length > MAX_CHAT) this.chatLog.splice(0, this.chatLog.length - MAX_CHAT)
    this.#emit('chat')
  }

  /**
   * The player still hasn't started after a while: autoplay refused, or Twitch asks the viewer to confirm a
   * mature-content warning. Only a click inside that player can start it.
   */
  waitingForClick(id: string): boolean {
    const tile = this.tile(id)
    const runtime = this.runtime.get(id)
    if (!tile || runtime?.chanceAt === undefined || runtime.played || runtime.state === 'offline') return false
    if (this.#relayed.has(id) || (tile.source.platform !== 'twitch' && tile.source.platform !== 'youtube')) return false
    return Date.now() - runtime.chanceAt > 8000
  }

  /**
   * A Twitch player that never started although Regie already sent it a `play()`: almost always the
   * viewer's own ad blocker, which Twitch detects and refuses to run with. The iframe is cross-origin,
   * so the player's error screen can't be read — this is the timing heuristic from `core/embed.ts`.
   */
  adblocked(id: string): boolean {
    const tile = this.tile(id)
    const runtime = this.runtime.get(id)
    if (!tile || !runtime || !this.embedTwitch(id)) return false
    return adblockSuspect(
      {
        since: runtime.chanceAt,
        played: runtime.played,
        retried: runtime.retried,
        offline: runtime.state === 'offline',
      },
      Date.now(),
    )
  }

  /** Twitch tiles that look blocked by the viewer's ad blocker, for the notice under the wall. */
  adblockedTiles(): string[] {
    return this.session.tiles.filter((tile) => this.adblocked(tile.id)).map((tile) => tile.id)
  }

  meter(id: string): number {
    const runtime = this.runtime.get(id)
    return runtime ? meter(runtime.hype, Date.now()) : 0
  }

  // ----- ticker -----

  #tick() {
    const now = Date.now()
    let changed = false
    for (const [id, runtime] of this.runtime) {
      runtime.hype = decayHype(runtime.hype, now)
      const tile = this.tile(id)
      const idle = tile ? this.#idle(tile, runtime, now) : false
      if (idle !== (runtime.idleSeen ?? false)) {
        runtime.idleSeen = idle
        changed = true
      }
      if (this.session.autoDirector && !this.ui.takeover && spike(runtime.hype, now) >= TAKEOVER_SPIKE) {
        if (this.mix().onAir !== id) {
          this.ui.takeover = { id, until: now + TAKEOVER_MS }
          changed = true
        }
      }
    }
    this.#resumePaused(now)
    // Twitch sometimes leaves a player "ready" without starting it: ask once more after 10 s.
    for (const [id, runtime] of this.runtime) {
      if (runtime.played || runtime.retried || runtime.chanceAt === undefined || now - runtime.chanceAt < 10_000)
        continue
      runtime.retried = true
      const player = this.players.get(id)
      if (player) safely(() => player.play())
    }
    // A player that stays unstarted after that retry is probably blocked by the viewer's ad blocker.
    const blocked = new Set(this.adblockedTiles())
    if (blocked.size !== this.#blocked.size || [...blocked].some((id) => !this.#blocked.has(id))) {
      this.#blocked = blocked
      changed = true
    }
    // A monitor that doesn't start within 7 s (a mature-content warning waits for a click) gives way.
    if (this.ui.warmup && now - this.ui.warmup.since > 7000) this.#nextWarmup(this.ui.warmup.id)
    if (this.ui.takeover && this.ui.takeover.until <= now) {
      this.ui.takeover = null
      changed = true
    }
    if (changed) this.changed(false)
    this.#emit('tick')
  }

  // ----- library -----

  presets(): library.Preset[] {
    return library.presets()
  }

  savePreset(name: string) {
    const clean = name.trim().slice(0, 60)
    if (!clean || !this.session.tiles.length) return
    library.savePreset(clean, encodeSession(this.session))
    this.toast('toast.saved')
  }

  deletePreset(name: string) {
    library.deletePreset(name)
    this.#emit('change')
  }

  openPreset(hash: string) {
    this.loadHash(hash)
    this.ui.libraryOpen = false
    this.#lastHash = ''
    this.changed()
  }

  openLibrary(tab?: typeof this.ui.libraryTab) {
    this.ui.libraryOpen = tab ? true : !this.ui.libraryOpen
    if (tab) this.ui.libraryTab = tab
    this.ui.helpOpen = false
    this.#emit('change')
  }

  toggleFavorite(id: string) {
    const tile = this.tile(id)
    if (!tile) return
    const added = library.toggleFavorite(tile.source, this.label(id))
    this.toast(added ? 'toast.favorite' : 'toast.unfavorite')
  }

  async copyLink() {
    clearTimeout(this.#hashTimer)
    const hash = encodeSession(this.session)
    const url = `${location.origin}${location.pathname}${hash ? `#${hash}` : ''}`
    try {
      await navigator.clipboard.writeText(url)
      this.toast('toast.copied')
    } catch {
      this.toast('toast.copyFailed')
    }
  }
}
