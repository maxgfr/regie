import { TypedEventTarget } from 'remix/component'
import { type ChatMessage, TwitchChat } from '../chat/irc.ts'
import { type AdSignal, type AdState, adReducer, adTick, initialAdState, shouldReload } from '../core/ads.ts'
import { mixAudio } from '../core/audio.ts'
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
import { decodeSession, defaultSession, encodeSession, newTile } from '../core/session.ts'
import { chatHold, planSync } from '../core/sync.ts'
import type { AudioMode, LayoutMode, Session, Source, Tile } from '../core/types.ts'
import { type Creator, kickChannel, twitchChannels } from '../platforms/directory.ts'
import { capabilities, sourceName } from '../platforms/parse.ts'
import { fetchTitle } from '../platforms/titles.ts'
import { createPlayer, type PlaybackState, type Player } from '../players/index.ts'
import { canPlayWithSound } from '../players/load-script.ts'
import * as library from './library.ts'

export interface TileRuntime {
  state: PlaybackState
  ad: AdState
  hype: HypeState
  latency?: number
  /** The player has played at least once: before that, a pause is a refused autoplay, not an ad. */
  played?: boolean
  /** When the player was mounted, to tell a slow start from a player waiting for a click. */
  mountedAt?: number
  /** A `play()` was already sent to a player that didn't start on its own. */
  retried?: boolean
  /** Title from the platform's oEmbed, when it has one. */
  title?: string
  /** Live status, title, category and audience of a Twitch or Kick channel. */
  info?: Creator
  /** Clap time for sync, `performance.now()` ms. */
  mark?: number
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
const MAX_CHAT = 400
const FADE_MS = 600

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
  chatLog: ChatMessage[] = []
  #pending: (ChatMessage & { release: number })[] = []
  #chat = new TwitchChat()
  #applied = new Map<string, number>()
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
    for (const key of [
      'liveChat',
      'antiSpoiler',
      'autoDirector',
      'adSwitch',
      'chatOpen',
      'autoAdd',
      'adReload',
    ] as const) {
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
    this.#reloads.clear()
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
    const runtime: TileRuntime = { state: 'loading', ad: initialAdState(now), hype: initialHype(now) }
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
  /** When each tile's player was reloaded for an ad. */
  #reloads = new Map<string, number[]>()

  attach(id: string, container: HTMLElement) {
    const tile = this.tile(id)
    if (!tile || this.players.has(id)) return
    this.#containers.set(id, container)
    const player = createPlayer({
      source: tile.source,
      container,
      host: this.#host,
      initialVolume: this.ui.soundAllowed ? (this.#targetVolumes()[id] ?? 0) : 0,
      events: {
        state: (state, byPlayer) => {
          const runtime = this.runtime.get(id)
          if (!runtime) return
          runtime.state = state
          if (state === 'playing') this.#applied.delete(id)
          if (state === 'playing') {
            if (!runtime.played && this.ui.warmup?.id === id) setTimeout(() => this.#nextWarmup(id), 1200)
            runtime.played = true
            this.#adSignal(id, { type: 'playing' })
          } else if (state === 'paused' && runtime.played) this.#adSignal(id, { type: 'paused', byUser: !byPlayer })
          else this.#emit('change')
        },
        progress: (time) => this.#adSignal(id, { type: 'progress', time }, false),
        latency: (seconds) => {
          const runtime = this.runtime.get(id)
          if (runtime) runtime.latency = seconds
        },
        userVolume: (volume, muted) => this.#fromPlayer(id, volume, muted),
        adHint: (on) => {
          const runtime = this.runtime.get(id)
          // A player that opens on a pre-roll ad has started, even if "playing" only comes after the ad.
          if (on && runtime && !runtime.played) {
            runtime.played = true
            if (this.ui.warmup?.id === id) setTimeout(() => this.#nextWarmup(id), 1200)
          }
          this.#adSignal(id, { type: 'hint', on })
          if (on) this.#reloadForAd(id)
        },
      },
    })
    if (player) {
      this.players.set(id, player)
      this.#applied.set(id, 0)
      const runtime = this.runtime.get(id)
      if (runtime) runtime.mountedAt = Date.now()
    }
  }

  /**
   * Twitch refuses to autoplay a player shown below 400×300, but one that started keeps playing once it is
   * made smaller. So each small Twitch monitor is shown on the main monitor for a moment until it plays: a
   * line check, as when a control room powers up its monitors.
   */
  warmUp(id: string) {
    const runtime = this.runtime.get(id)
    if (!runtime || runtime.played || this.#warmQueue.includes(id) || this.ui.warmup?.id === id) return
    this.#warmQueue.push(id)
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
        tile.source.platform === 'twitch' &&
        !this.#warmQueue.includes(tile.id) &&
        tile.id !== finished &&
        runtime?.mountedAt !== undefined &&
        !runtime.played &&
        now - runtime.mountedAt < 7000
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
    this.ui.warmup = next ? { id: next, since: Date.now() } : null
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

  /**
   * A Twitch player went to an ad: reload just that player (the rest of the wall keeps playing). A fresh
   * player sometimes comes back without the ad; the tries are limited so a stubborn ad can't loop.
   */
  #reloadForAd(id: string) {
    const tile = this.tile(id)
    if (!this.session.adReload || tile?.source.platform !== 'twitch') return
    const now = Date.now()
    const history = (this.#reloads.get(id) ?? []).filter((at) => now - at < 10 * 60_000)
    if (!shouldReload(history, now)) return
    this.#reloads.set(id, [...history, now])
    // Leave the ad a moment to settle, so the reload doesn't race the player's own ad request.
    setTimeout(() => this.reloadPlayer(id), 1500)
  }

  /** Mounts a tile's player again, in place. */
  reloadPlayer(id: string) {
    const container = this.#containers.get(id)
    const runtime = this.runtime.get(id)
    if (!container || !runtime || !this.players.has(id)) return
    this.#detach(id)
    runtime.ad = initialAdState(Date.now())
    runtime.played = false
    runtime.retried = false
    runtime.state = 'loading'
    this.attach(id, container)
    // A small monitor needs its line check again to start (Twitch only autoplays large players).
    this.warmUp(id)
    this.changed(false)
  }

  setAdReload(on: boolean) {
    this.session.adReload = on
    this.changed()
  }

  /** Matches a player's stream quality to the size it is shown at (Twitch). */
  fitPlayer(id: string, displayHeight: number, large: boolean) {
    const player = this.players.get(id)
    if (player?.fit) safely(() => player.fit?.(displayHeight, large))
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
    this.#reloads.delete(id)
  }

  #detach(id: string) {
    this.players.get(id)?.destroy()
    this.players.delete(id)
    this.#applied.delete(id)
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
    this.#reloads.clear()
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

  /** The tile on air after ads, takeovers and the "listen" key, and whether it covers an ad. */
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
          inAd: runtime?.ad.inAd ?? false,
          hype: runtime ? spike(runtime.hype, now) : 0,
        }
      }),
      mode: this.session.audioMode,
      audioId: this.session.audioId,
      listenId: this.ui.listenId ?? takeover,
      duck: this.session.duck,
      master: this.session.master,
      adSwitch: this.session.adSwitch,
    })
  }

  #targetVolumes(): Record<string, number> {
    return this.mix().volumes
  }

  /** Twitch tiles in an ad, for the notice that explains why they are shown large. */
  twitchAds(): string[] {
    return this.session.tiles
      .filter((tile) => tile.source.platform === 'twitch' && this.runtime.get(tile.id)?.ad.inAd)
      .map((tile) => tile.id)
  }

  /** The main tile. An ad never moves it: Twitch only counts an ad down while its player is large and visible. */
  effectiveFocus(): string | null {
    return this.session.focusId
  }

  /**
   * The tile to show large for a while, if any: the one in a line check, else a small Twitch tile in an ad.
   * `small` tells whether a tile is below the size Twitch needs.
   */
  boostCandidate(small: (id: string) => boolean): string | null {
    if (this.ui.warmup && small(this.ui.warmup.id)) return this.ui.warmup.id
    const inAd = this.session.tiles.find(
      (tile) => tile.source.platform === 'twitch' && this.runtime.get(tile.id)?.ad.inAd && small(tile.id),
    )
    return inAd?.id ?? null
  }

  setMiniRegie(open: boolean) {
    this.ui.miniRegie = open
    this.changed(false)
  }

  #applyAudio(immediate = false) {
    const target = this.ui.soundAllowed && !this.ui.miniRegie ? this.#targetVolumes() : {}
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
      const caps = capabilities(this.tile(id)?.source ?? { platform: 'iframe', kind: 'live', id: '' })
      if (!caps.volume) {
        if (progress === 1) this.#setVolume(id, player, to)
        continue
      }
      this.#setVolume(id, player, Math.round((from + (to - from) * eased) * 100) / 100)
    }
    if (progress < 1) setTimeout(this.#stepFade, 50)
    else this.#fade = null
  }

  playAll() {
    for (const player of this.players.values()) safely(() => player.play())
  }

  pauseAll() {
    for (const player of this.players.values()) safely(() => player.pause())
  }

  /** Moves every seekable tile by the same amount, keeping their offsets (multi-POV replays). */
  seekAll(seconds: number) {
    for (const player of this.players.values()) safely(() => player.seekBy(seconds))
  }

  // ----- ads -----

  #adSignal(id: string, signal: AdSignal, render = true) {
    const runtime = this.runtime.get(id)
    if (!runtime) return
    const before = runtime.ad.inAd
    runtime.ad = adReducer(runtime.ad, signal, Date.now())
    // The player may have changed its own sound around an ad: send the mix again rather than trust the cache.
    if (runtime.ad.inAd !== before) this.#applied.delete(id)
    if (runtime.ad.inAd !== before || render) this.changed(false)
  }

  toggleAd(id: string) {
    const runtime = this.runtime.get(id)
    if (runtime) this.#adSignal(id, { type: 'manual', on: !runtime.ad.inAd })
  }

  setAdSwitch(on: boolean) {
    this.session.adSwitch = on
    this.changed()
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
        canDelay: capabilities(tile.source).seek && this.players.has(tile.id),
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
    if (capabilities(tile.source).seek && safely(() => this.players.get(tile.id)?.seekBy(-(next - tile.delay)))) {
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
    return this.session.tiles.filter((tile) => capabilities(tile.source).chat)
  }

  twitchTile(channel: string): Tile | undefined {
    return this.session.tiles.find(
      (tile) => tile.source.platform === 'twitch' && tile.source.kind === 'live' && tile.source.id === channel,
    )
  }

  #syncChat() {
    const channels = this.session.liveChat
      ? this.session.tiles.filter((tile) => capabilities(tile.source).liveChat).map((tile) => tile.source.id)
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
    if (!tile || !runtime?.mountedAt || runtime.played || runtime.state === 'offline') return false
    if (tile.source.platform !== 'twitch' && tile.source.platform !== 'youtube') return false
    return Date.now() - runtime.mountedAt > 8000
  }

  meter(id: string): number {
    const runtime = this.runtime.get(id)
    return runtime ? meter(runtime.hype, Date.now()) : 0
  }

  // ----- ticker -----

  #tick() {
    const now = Date.now()
    let adChanged = false
    for (const [id, runtime] of this.runtime) {
      runtime.hype = decayHype(runtime.hype, now)
      const before = runtime.ad.inAd
      runtime.ad = adTick(runtime.ad, now, runtime.state === 'playing')
      if (runtime.ad.inAd !== before) adChanged = true
      if (this.session.autoDirector && !this.ui.takeover && spike(runtime.hype, now) >= TAKEOVER_SPIKE) {
        if (this.mix().onAir !== id) {
          this.ui.takeover = { id, until: now + TAKEOVER_MS }
          adChanged = true
        }
      }
    }
    // Twitch sometimes leaves a player "ready" without starting it: ask once more after 10 s.
    for (const [id, runtime] of this.runtime) {
      if (runtime.played || runtime.retried || !runtime.mountedAt || now - runtime.mountedAt < 10_000) continue
      runtime.retried = true
      const player = this.players.get(id)
      if (player) safely(() => player.play())
    }
    // A monitor that doesn't start within 7 s (a mature-content warning waits for a click) gives way.
    if (this.ui.warmup && now - this.ui.warmup.since > 7000) this.#nextWarmup(this.ui.warmup.id)
    if (this.ui.takeover && this.ui.takeover.until <= now) {
      this.ui.takeover = null
      adChanged = true
    }
    if (adChanged) this.changed(false)
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
