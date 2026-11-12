import type { AudioMode, Session, Source } from '../core/types.ts'

/**
 * What Regie keeps in this browser, and nowhere else: favourite channels, recently watched sources,
 * named setups and default settings. Everything can be exported to a file and imported back.
 */

export interface Favorite {
  source: Source
  name: string
  addedAt: number
}

export interface Recent {
  source: Source
  name: string
  at: number
}

export interface Preset {
  name: string
  hash: string
  savedAt: number
}

/** Settings a new session starts with. A shared link still wins: it carries its own. */
export interface Preferences {
  audioMode: AudioMode
  transition: 'cut' | 'mix'
  duck: number
  liveChat: boolean
  antiSpoiler: boolean
  autoDirector: boolean
  adSwitch: boolean
  chatOpen: boolean
  keywords: string[]
}

export interface Backup {
  app: 'regie'
  version: 1
  exportedAt: string
  favorites: Favorite[]
  recents: Recent[]
  presets: Preset[]
  preferences: Partial<Preferences>
  locale?: string
}

const KEYS = {
  favorites: 'regie:favorites',
  recents: 'regie:recents',
  presets: 'regie:presets',
  preferences: 'regie:preferences',
  locale: 'regie:locale',
}

const MAX_RECENTS = 40

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or disabled: the session still works, it just isn't remembered.
  }
}

const sameSource = (a: Source, b: Source) => a.platform === b.platform && a.kind === b.kind && a.id === b.id

function isSource(value: unknown): value is Source {
  const source = value as Source
  return (
    Boolean(source) &&
    typeof source.platform === 'string' &&
    typeof source.kind === 'string' &&
    typeof source.id === 'string'
  )
}

export function favorites(): Favorite[] {
  return read<Favorite[]>(KEYS.favorites, []).filter((f) => isSource(f?.source))
}

export function isFavorite(source: Source): boolean {
  return favorites().some((favorite) => sameSource(favorite.source, source))
}

export function toggleFavorite(source: Source, name: string): boolean {
  const list = favorites()
  const exists = list.some((favorite) => sameSource(favorite.source, source))
  write(
    KEYS.favorites,
    exists ? list.filter((f) => !sameSource(f.source, source)) : [{ source, name, addedAt: Date.now() }, ...list],
  )
  return !exists
}

export function recents(): Recent[] {
  return read<Recent[]>(KEYS.recents, []).filter((r) => isSource(r?.source))
}

export function rememberRecent(source: Source, name: string) {
  const list = recents().filter((recent) => !sameSource(recent.source, source))
  write(KEYS.recents, [{ source, name, at: Date.now() }, ...list].slice(0, MAX_RECENTS))
}

export function clearRecents() {
  write(KEYS.recents, [])
}

export function presets(): Preset[] {
  return read<Preset[]>(KEYS.presets, []).filter((p) => typeof p?.name === 'string' && typeof p?.hash === 'string')
}

export function savePreset(name: string, hash: string) {
  write(KEYS.presets, [{ name, hash, savedAt: Date.now() }, ...presets().filter((p) => p.name !== name)].slice(0, 50))
}

export function deletePreset(name: string) {
  write(
    KEYS.presets,
    presets().filter((preset) => preset.name !== name),
  )
}

export function preferences(): Partial<Preferences> {
  return read<Partial<Preferences>>(KEYS.preferences, {})
}

export function savePreferences(session: Session) {
  const { audioMode, transition, duck, liveChat, antiSpoiler, autoDirector, adSwitch, chatOpen, keywords } = session
  write(KEYS.preferences, {
    audioMode,
    transition,
    duck,
    liveChat,
    antiSpoiler,
    autoDirector,
    adSwitch,
    chatOpen,
    keywords,
  })
}

export function clearPreferences() {
  localStorage.removeItem(KEYS.preferences)
}

export function exportBackup(): Backup {
  return {
    app: 'regie',
    version: 1,
    exportedAt: new Date().toISOString(),
    favorites: favorites(),
    recents: recents(),
    presets: presets(),
    preferences: preferences(),
    locale: localStorage.getItem(KEYS.locale) ?? undefined,
  }
}

/** Merges a backup into this browser. Returns the number of items it brought, or null if it isn't one. */
export function importBackup(data: unknown): number | null {
  const backup = data as Partial<Backup>
  if (backup?.app !== 'regie' || backup.version !== 1) return null
  let count = 0
  const favs = favorites()
  for (const favorite of Array.isArray(backup.favorites) ? backup.favorites : []) {
    if (!isSource(favorite?.source) || favs.some((f) => sameSource(f.source, favorite.source))) continue
    favs.push({
      source: favorite.source,
      name: String(favorite.name ?? favorite.source.id),
      addedAt: Number(favorite.addedAt) || Date.now(),
    })
    count++
  }
  write(KEYS.favorites, favs)
  let sets = presets()
  for (const preset of Array.isArray(backup.presets) ? backup.presets : []) {
    if (typeof preset?.name !== 'string' || typeof preset?.hash !== 'string') continue
    sets = [
      { name: preset.name, hash: preset.hash, savedAt: Number(preset.savedAt) || Date.now() },
      ...sets.filter((p) => p.name !== preset.name),
    ]
    count++
  }
  write(KEYS.presets, sets.slice(0, 50))
  const merged = [...recents()]
  for (const recent of Array.isArray(backup.recents) ? backup.recents : []) {
    if (isSource(recent?.source) && !merged.some((r) => sameSource(r.source, recent.source))) merged.push(recent)
  }
  write(KEYS.recents, merged.sort((a, b) => b.at - a.at).slice(0, MAX_RECENTS))
  if (backup.preferences && typeof backup.preferences === 'object') write(KEYS.preferences, backup.preferences)
  if (backup.locale === 'en' || backup.locale === 'fr') localStorage.setItem(KEYS.locale, backup.locale)
  return count
}
