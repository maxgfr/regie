import { Download, Plus, RefreshCw, Star, Trash2, Upload, X } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'
import * as library from '../app/library.ts'
import type { Store } from '../app/store.ts'
import { decodeSession } from '../core/session.ts'
import type { Source } from '../core/types.ts'
import { t } from '../i18n/index.ts'
import { type Creator, kickChannel, searchCreators, twitchChannels } from '../platforms/directory.ts'
import { platformLabel, sourceName } from '../platforms/parse.ts'
import { keyStyle } from './controls.tsx'
import { Icon } from './Icon.tsx'
import { sheetStyle } from './Sheets.tsx'

type Tab = Store['ui']['libraryTab']

const libraryStyle = css({
  width: 'clamp(340px, 34vw, 520px)',
  '& .tabs': { display: 'flex', gap: '2px', marginBottom: '14px', borderBottom: '1px solid var(--line)' },
  '& .tabs button': {
    padding: '8px 12px',
    border: 0,
    background: 'transparent',
    color: 'var(--dim)',
    fontFamily: 'var(--font-label)',
    fontWeight: 600,
    fontSize: '15px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  '& .tabs button:hover': { color: 'var(--text)' },
  '& .tabs button[aria-selected="true"]': { color: 'var(--text)', boxShadow: 'inset 0 -2px 0 var(--amber)' },
  '& .search': { display: 'flex', gap: '6px', marginBottom: '10px' },
  '& .search input': {
    flex: '1 1 auto',
    minWidth: 0,
    height: '36px',
    padding: '0 12px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: '#0c0d0e',
  },
  '& .hint': { margin: '8px 0 0', color: 'var(--dim)', fontSize: '13px' },
  '& .hint a': { color: 'var(--amber)' },
  '& .creators': { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' },
  '& .creator': {
    display: 'grid',
    gridTemplateColumns: '36px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 8px',
    borderRadius: '4px',
  },
  '& .creator:hover': { background: '#181b1e' },
  '& .avatar': { width: '36px', height: '36px', borderRadius: '50%', background: 'var(--key)', objectFit: 'cover' },
  '& .who': { minWidth: 0 },
  '& .who strong': { fontWeight: 600 },
  '& .who .meta': {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--dim)',
    fontSize: '13px',
  },
  '& .badge': {
    display: 'inline-block',
    marginLeft: '6px',
    padding: '0 5px',
    borderRadius: '2px',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    verticalAlign: '1px',
    background: 'var(--key)',
    color: 'var(--dim)',
  },
  '& .badge[data-live="true"]': { background: 'var(--pgm)', color: '#fff' },
  '& .platform': {
    color: 'var(--dim)',
    fontSize: '12px',
    fontFamily: 'var(--font-label)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  '& .actions': { display: 'flex', gap: '4px' },
  '& .actions button': {
    display: 'grid',
    placeItems: 'center',
    width: '32px',
    height: '32px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: 'var(--key)',
    color: 'var(--dim)',
  },
  '& .actions button:hover:not(:disabled)': { color: 'var(--text)', background: 'var(--key-hover)' },
  '& .actions button[aria-pressed="true"]': { color: 'var(--amber)' },
  '& .actions button:disabled': { opacity: 0.4, cursor: 'default' },
  '& .toolbar': { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' },
  '& .empty': { color: 'var(--dim)', fontSize: '14px' },
  '& .file': { position: 'relative', overflow: 'hidden' },
  '& .file input': { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' },
})

const number = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

function CreatorRow(
  handle: Handle<{
    store: Store
    source: Source
    name: string
    creator?: Creator
    onChange: (refresh?: boolean) => void
  }>,
) {
  return () => {
    const { store, source, name, creator, onChange } = handle.props
    const onWall = store.session.tiles.some(
      (tile) =>
        tile.source.platform === source.platform && tile.source.id === source.id && tile.source.kind === source.kind,
    )
    const favorite = library.isFavorite(source)
    const meta = creator?.live
      ? [creator.category, creator.title].filter(Boolean).join(' · ')
      : creator
        ? t('library.offline')
        : platformLabel(source.platform)
    return (
      <li class="creator">
        {creator?.avatar ? (
          <img class="avatar" src={creator.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span class="avatar" aria-hidden="true" />
        )}
        <span class="who">
          <strong>{creator?.name ?? name}</strong>
          <span class="platform"> · {platformLabel(source.platform)}</span>
          {creator && (
            <span class="badge" data-live={creator.live}>
              {creator.live
                ? `${t('library.live')}${creator.viewers ? ` · ${number(creator.viewers)}` : ''}`
                : t('library.offline')}
            </span>
          )}
          <span class="meta" title={meta}>
            {meta}
          </span>
        </span>
        <span class="actions">
          <button
            type="button"
            aria-pressed={favorite}
            aria-label={favorite ? t('library.unfavorite', { name }) : t('library.favorite', { name })}
            title={favorite ? t('library.unfavorite', { name }) : t('library.favorite', { name })}
            mix={on('click', () => {
              library.toggleFavorite(source, creator?.name ?? name)
              onChange(true)
            })}
          >
            <Icon icon={Star} />
          </button>
          <button
            type="button"
            disabled={onWall}
            aria-label={onWall ? t('library.added') : t('library.add', { name })}
            title={onWall ? t('library.added') : t('library.add', { name })}
            mix={on('click', () => {
              store.add(source)
              onChange()
            })}
          >
            <Icon icon={Plus} />
          </button>
        </span>
      </li>
    )
  }
}

const creatorSource = (creator: Creator): Source => ({ platform: creator.platform, kind: 'live', id: creator.id })

export function LibrarySheet(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let query = ''
  let searched = ''
  let searching = false
  let results: Creator[] = []
  const status = new Map<string, Creator>()
  let presetName = ''
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const focusSearch = ref((node: HTMLInputElement) => setTimeout(() => node.focus(), 0))

  const key = (source: Source) => `${source.platform}:${source.id}`

  const search = (text: string) => {
    clearTimeout(timer)
    controller?.abort()
    if (text.trim().length < 2) {
      results = []
      searched = ''
      searching = false
      handle.update()
      return
    }
    searching = true
    handle.update()
    timer = setTimeout(async () => {
      controller = new AbortController()
      const found = await searchCreators(text.trim(), controller.signal)
      if (controller.signal.aborted) return
      results = found.slice(0, 20)
      searched = text.trim()
      searching = false
      handle.update()
    }, 300)
  }

  /** Live status of favourites and recent channels. */
  const refresh = async () => {
    const sources = [...library.favorites(), ...library.recents()].map((item) => item.source)
    const twitch = [...new Set(sources.filter((s) => s.platform === 'twitch' && s.kind === 'live').map((s) => s.id))]
    const kick = [...new Set(sources.filter((s) => s.platform === 'kick').map((s) => s.id))].slice(0, 12)
    const [found, kicks] = await Promise.all([twitchChannels(twitch), Promise.all(kick.map((id) => kickChannel(id)))])
    for (const creator of [...found, ...kicks]) if (creator) status.set(`${creator.platform}:${creator.id}`, creator)
    handle.update()
  }
  refresh()

  const close = () => store.openLibrary()
  const setTab = (tab: Tab) => {
    store.ui.libraryTab = tab
    store.changed(false)
    if (tab === 'favorites' || tab === 'recent') refresh()
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(library.exportBackup(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `regie-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return () => {
    const tab = store.ui.libraryTab
    const tabs: [Tab, string][] = [
      ['search', t('library.search')],
      ['favorites', t('library.favorites')],
      ['recent', t('library.recent')],
      ['setups', t('library.setups')],
      ['data', t('library.data')],
    ]
    const favorites = library.favorites()
    const liveFavorites = favorites.filter((f) => status.get(key(f.source))?.live)
    const update = (again?: boolean) => {
      handle.update()
      if (again) refresh()
    }

    return (
      <section role="dialog" aria-labelledby="library-title" mix={[sheetStyle, libraryStyle]}>
        <header>
          <h2 id="library-title">{t('library.title')}</h2>
          <button type="button" class="close" aria-label={t('help.close')} mix={on('click', close)}>
            <Icon icon={X} />
          </button>
        </header>
        <div class="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} mix={on('click', () => setTab(id))}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'search' && (
          <div role="tabpanel">
            <form
              class="search"
              mix={on('submit', (event) => {
                event.preventDefault()
                search(query)
              })}
            >
              <label class="sr-only" for="creator-search">
                {t('library.searchLabel')}
              </label>
              <input
                id="creator-search"
                type="search"
                autocomplete="off"
                placeholder={t('library.searchPlaceholder')}
                value={query}
                mix={[
                  focusSearch,
                  on('input', (event) => {
                    query = event.currentTarget.value
                    search(query)
                  }),
                ]}
              />
            </form>
            {searching && <p class="empty">{t('library.searching')}</p>}
            {!searching && searched && !results.length && (
              <p class="empty">{t('library.noResults', { q: searched })}</p>
            )}
            <ul class="creators">
              {results.map((creator) => (
                <CreatorRow
                  key={key(creatorSource(creator))}
                  store={store}
                  source={creatorSource(creator)}
                  name={creator.name}
                  creator={creator}
                  onChange={update}
                />
              ))}
            </ul>
            <p class="hint">{t('library.searchHint')}</p>
            <p class="hint">
              {t('library.youtube')}{' '}
              {query.trim().length > 1 && (
                <a
                  href={`https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}&sp=EgJAAQ%253D%253D`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('library.youtubeOpen', { q: query.trim() })}
                </a>
              )}
            </p>
          </div>
        )}

        {tab === 'favorites' && (
          <div role="tabpanel">
            <div class="toolbar">
              <button
                type="button"
                data-tone="red"
                aria-pressed={liveFavorites.length > 0}
                disabled={!liveFavorites.length}
                mix={[keyStyle, on('click', () => store.addMany(liveFavorites.map((f) => f.source)))]}
              >
                {t('library.addLive', { n: liveFavorites.length })}
              </button>
              <button type="button" data-tone="white" mix={[keyStyle, on('click', () => refresh())]}>
                <Icon icon={RefreshCw} /> {t('library.refresh')}
              </button>
            </div>
            {favorites.length ? (
              <ul class="creators">
                {favorites
                  .slice()
                  .sort(
                    (a, b) =>
                      Number(status.get(key(b.source))?.live ?? 0) - Number(status.get(key(a.source))?.live ?? 0),
                  )
                  .map((favorite) => (
                    <CreatorRow
                      key={key(favorite.source)}
                      store={store}
                      source={favorite.source}
                      name={favorite.name}
                      creator={status.get(key(favorite.source))}
                      onChange={update}
                    />
                  ))}
              </ul>
            ) : (
              <p class="empty">{t('library.noFavorites')}</p>
            )}
          </div>
        )}

        {tab === 'recent' && (
          <div role="tabpanel">
            {library.recents().length ? (
              <>
                <ul class="creators">
                  {library.recents().map((recent) => (
                    <CreatorRow
                      key={`${key(recent.source)}:${recent.source.kind}`}
                      store={store}
                      source={recent.source}
                      name={recent.name || sourceName(recent.source)}
                      creator={status.get(key(recent.source))}
                      onChange={update}
                    />
                  ))}
                </ul>
                <div class="toolbar" style={{ marginTop: '12px' }}>
                  <button
                    type="button"
                    data-tone="white"
                    mix={[
                      keyStyle,
                      on('click', () => {
                        library.clearRecents()
                        handle.update()
                      }),
                    ]}
                  >
                    {t('library.clearRecent')}
                  </button>
                </div>
              </>
            ) : (
              <p class="empty">{t('library.noRecent')}</p>
            )}
          </div>
        )}

        {tab === 'setups' && (
          <div role="tabpanel">
            {store.session.tiles.length > 0 && (
              <form
                mix={on('submit', (event) => {
                  event.preventDefault()
                  store.savePreset(presetName)
                  presetName = ''
                  handle.update()
                })}
              >
                <label class="sr-only" for="preset-name">
                  {t('sessions.name')}
                </label>
                <input
                  id="preset-name"
                  type="text"
                  value={presetName}
                  placeholder={t('sessions.namePlaceholder')}
                  mix={on('input', (event) => {
                    presetName = event.currentTarget.value
                    handle.update()
                  })}
                />
                <button type="submit" disabled={!presetName.trim()} data-tone="white" mix={keyStyle}>
                  {t('sessions.save')}
                </button>
              </form>
            )}
            {store.presets().length ? (
              <ul>
                {store.presets().map((preset) => (
                  <li key={preset.name}>
                    <button type="button" class="open" mix={on('click', () => store.openPreset(preset.hash))}>
                      <span>{preset.name}</span>
                      <span class="count">{t('sessions.count', { n: decodeSession(preset.hash).tiles.length })}</span>
                    </button>
                    <button
                      type="button"
                      class="close"
                      aria-label={t('sessions.delete', { name: preset.name })}
                      title={t('sessions.delete', { name: preset.name })}
                      mix={on('click', () => store.deletePreset(preset.name))}
                    >
                      <Icon icon={Trash2} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="empty">{t('sessions.empty')}</p>
            )}
            {store.session.tiles.length > 0 && (
              <button
                type="button"
                class="danger"
                data-tone="white"
                mix={[
                  keyStyle,
                  on('click', () => {
                    store.clear()
                    close()
                  }),
                ]}
              >
                {t('sessions.clear')}
              </button>
            )}
          </div>
        )}

        {tab === 'data' && (
          <div role="tabpanel">
            <p>{t('library.dataText')}</p>
            <div class="toolbar" style={{ marginTop: '12px' }}>
              <button type="button" data-tone="white" mix={[keyStyle, on('click', download)]}>
                <Icon icon={Download} /> {t('library.export')}
              </button>
              <label class="file" data-tone="white" mix={keyStyle}>
                <Icon icon={Upload} /> {t('library.import')}
                <input
                  type="file"
                  accept="application/json,.json"
                  mix={on('change', async (event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (!file) return
                    try {
                      const count = library.importBackup(JSON.parse(await file.text()))
                      store.toast(count === null ? 'toast.importFailed' : t('toast.imported', { n: count }))
                    } catch {
                      store.toast('toast.importFailed')
                    }
                    refresh()
                  })}
                />
              </label>
            </div>
            <p class="hint" style={{ marginTop: '18px' }}>
              {t('library.prefsText')}
            </p>
            <div class="toolbar" style={{ marginTop: '8px' }}>
              <button
                type="button"
                data-tone="white"
                mix={[
                  keyStyle,
                  on('click', () => {
                    library.clearPreferences()
                    store.toast('toast.prefsReset')
                  }),
                ]}
              >
                {t('library.resetPrefs')}
              </button>
            </div>
          </div>
        )}
      </section>
    )
  }
}
