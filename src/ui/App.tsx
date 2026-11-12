import { Megaphone, Power, Timer, Volume2 } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'
import type { Store } from '../app/store.ts'
import { isMessageKey, t } from '../i18n/index.ts'
import { capabilities, parseSource } from '../platforms/parse.ts'
import { ChatDock } from './ChatDock.tsx'
import { Console } from './Console.tsx'
import { keyStyle } from './controls.tsx'
import { EmptyState } from './EmptyState.tsx'
import { Icon } from './Icon.tsx'
import { installKeyboard } from './keyboard.ts'
import { LibrarySheet } from './Library.tsx'
import { HelpSheet } from './Sheets.tsx'
import { Stage } from './Stage.tsx'

const appStyle = css({
  height: '100dvh',
  display: 'grid',
  gridTemplateRows: 'minmax(0, 1fr) auto auto',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  '& > .wall': { position: 'relative', minWidth: 0, minHeight: 0, background: 'var(--ground)' },
  '& > aside, & > [role="dialog"]': { gridRow: '1 / 3', gridColumn: 2 },
  // Notices sit between the wall and the console, never over a player (Twitch won't autoplay a covered one).
  '& > .notices': { gridRow: 2, gridColumn: 1, display: 'grid', minWidth: 0 },
  '& > .console': { gridRow: 3, gridColumn: '1 / -1' },
})

const bannerStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '10px',
  padding: '7px 14px',
  background: 'var(--amber)',
  color: '#1a1000',
  fontFamily: 'var(--font-label)',
  fontWeight: 700,
  fontSize: '15px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
})

const syncBarStyle = css({
  display: 'grid',
  gap: '8px',
  padding: '12px 16px',
  borderTop: '2px solid var(--amber)',
  background: '#111315',
  '& h2': {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: 'var(--font-label)',
    fontSize: '20px',
    fontWeight: 700,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    color: 'var(--amber)',
  },
  '& p': { margin: 0, fontSize: '14px', color: '#c9ccc6' },
  '& .small': { color: 'var(--dim)', fontSize: '13px' },
  '& .actions': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  '& .count': { marginLeft: 'auto', color: 'var(--dim)', fontFamily: 'var(--font-mono)', fontSize: '13px' },
})

const warmupStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  padding: '6px 14px',
  background: '#111315',
  borderTop: '1px solid var(--pvw)',
  color: 'var(--pvw)',
  fontFamily: 'var(--font-label)',
  fontWeight: 600,
  fontSize: '14px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
})

const adNoticeStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  padding: '6px 14px',
  background: '#111315',
  borderTop: '1px solid var(--amber)',
  color: 'var(--amber)',
  fontFamily: 'var(--font-label)',
  fontWeight: 600,
  fontSize: '14px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
})

const alertStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minWidth: 0,
  padding: '6px 14px',
  background: '#111315',
  borderTop: '1px solid var(--pgm)',
  '& img': { width: '24px', height: '24px', borderRadius: '50%' },
  '& strong': {
    flex: 'none',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--pgm-ink)',
  },
  '& .meta': {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--dim)',
    fontSize: '14px',
  },
})

const toastStyle = css({
  padding: '7px 16px',
  background: '#e6e8e3',
  color: '#0b0c0d',
  fontWeight: 500,
  textAlign: 'center',
})

const dropStyle = css({
  position: 'absolute',
  inset: 0,
  zIndex: 40,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(11,12,13,0.82)',
  border: '3px dashed var(--amber)',
  fontFamily: 'var(--font-label)',
  fontSize: '28px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--amber)',
})

function SyncBar(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  return () => {
    const marks = store.marks()
    const fixed = store.session.tiles.filter((tile) => !capabilities(tile.source).seek).length
    return (
      <section aria-labelledby="sync-title" mix={syncBarStyle}>
        <h2 id="sync-title">
          <Icon icon={Timer} size={18} /> {t('sync.title')}
        </h2>
        <p>{t('sync.help')}</p>
        {fixed > 0 && <p class="small">{t('sync.note')}</p>}
        <div class="actions">
          <button
            type="button"
            data-tone="amber"
            aria-pressed="true"
            disabled={marks < 2}
            title={marks < 2 ? t('sync.need') : undefined}
            mix={[keyStyle, on('click', () => store.applySync())]}
          >
            {t('sync.apply')}
          </button>
          <button type="button" data-tone="white" mix={[keyStyle, on('click', () => store.resetSync())]}>
            {t('sync.reset')}
          </button>
          <button type="button" data-tone="white" mix={[keyStyle, on('click', () => store.openSync(false))]}>
            {t('sync.cancel')}
          </button>
          <span class="small">{t('sync.nudge')}</span>
          <span class="count" aria-live="polite">
            {marks}/{store.session.tiles.length}
          </span>
        </div>
      </section>
    )
  }
}

export function App(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let input: HTMLInputElement | undefined
  let dropping = false
  let dragDepth = 0
  store.addEventListener('change', () => handle.update(), { signal: handle.signal })
  installKeyboard(
    store,
    () => (store.session.tiles.length ? input : document.getElementById('empty-input')) as HTMLInputElement | null,
    handle.signal,
  )

  const externalDrag = (event: DragEvent) =>
    !event.dataTransfer?.types.includes('application/x-regie-tile') &&
    (event.dataTransfer?.types.includes('text/uri-list') || event.dataTransfer?.types.includes('text/plain'))

  const root = ref((node: HTMLElement, signal) => {
    const enter = (event: DragEvent) => {
      if (!externalDrag(event)) return
      dragDepth++
      if (!dropping) {
        dropping = true
        handle.update()
      }
    }
    const leave = () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0 && dropping) {
        dropping = false
        handle.update()
      }
    }
    node.addEventListener('dragenter', enter, { signal })
    node.addEventListener('dragleave', leave, { signal })
  })

  return () => {
    const { session, ui } = store
    const toast = ui.toast && isMessageKey(ui.toast) ? t(ui.toast) : ui.toast
    return (
      <div mix={[appStyle, root]}>
        <main class="wall">
          {session.tiles.length ? <Stage store={store} /> : <EmptyState store={store} />}
          {dropping && (
            <div
              mix={[
                dropStyle,
                on('dragover', (event) => event.preventDefault()),
                on('drop', (event) => {
                  event.preventDefault()
                  dropping = false
                  dragDepth = 0
                  const text =
                    event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || ''
                  const sources = text
                    .split(/\s+/)
                    .filter((line) => line && !line.startsWith('#'))
                    .map(parseSource)
                    .filter((source) => source !== null)
                  if (sources.length) store.addMany(sources)
                  else store.toast('input.invalid')
                  handle.update()
                }),
              ]}
            >
              {t('drop.hint')}
            </div>
          )}
        </main>
        <div class="notices">
          {session.tiles.length > 0 && !ui.soundAllowed && (
            <div role="status" mix={bannerStyle}>
              <Icon icon={Volume2} size={18} /> {t('sound.gate')}
            </div>
          )}
          {ui.warmup && (
            <div role="status" mix={warmupStyle}>
              <Icon icon={Power} size={16} />
              {t('warmup.text', {
                name: store.label(ui.warmup.id),
                done: store.warmupProgress().done,
                total: store.warmupProgress().total,
              })}
            </div>
          )}
          {!ui.warmup && store.twitchAds()[0] && (
            <div role="status" mix={adNoticeStyle}>
              <Icon icon={Megaphone} size={16} />
              {t('ad.notice', { name: store.label(store.twitchAds()[0] as string) })}
            </div>
          )}
          {ui.liveAlerts.map((creator) => (
            <div key={`${creator.platform}:${creator.id}`} role="status" mix={alertStyle}>
              {creator.avatar && <img src={creator.avatar} alt="" referrerPolicy="no-referrer" />}
              <strong>{t('alert.live', { name: creator.name })}</strong>
              <span class="meta">{[creator.category, creator.title].filter(Boolean).join(' · ')}</span>
              <button
                type="button"
                data-tone="red"
                aria-pressed="true"
                mix={[keyStyle, on('click', () => store.dismissAlert(creator, true))]}
              >
                {t('alert.add')}
              </button>
              <button
                type="button"
                data-tone="white"
                mix={[keyStyle, on('click', () => store.dismissAlert(creator, false))]}
              >
                {t('alert.dismiss')}
              </button>
            </div>
          ))}
          {ui.syncOpen && <SyncBar store={store} />}
          {toast && (
            <div role="status" mix={toastStyle}>
              {toast}
            </div>
          )}
        </div>
        {ui.libraryOpen ? (
          <LibrarySheet store={store} />
        ) : ui.helpOpen ? (
          <HelpSheet store={store} />
        ) : (
          session.chatOpen && session.tiles.length > 0 && <ChatDock store={store} />
        )}
        <Console store={store} inputRef={(node) => (input = node)} />
      </div>
    )
  }
}
