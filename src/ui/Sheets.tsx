import { X } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'
import type { Store } from '../app/store.ts'
import { type Locale, locale, type MessageKey, setLocale, t } from '../i18n/index.ts'
import { keyStyle } from './controls.tsx'
import { Icon } from './Icon.tsx'

/** Side panels dock beside the wall, like the chat: nothing may cover a player (Twitch won't autoplay it). */
export const sheetStyle = css({
  width: 'clamp(320px, 30vw, 460px)',
  minHeight: 0,
  overflowY: 'auto',
  padding: '18px 20px 20px',
  background: 'var(--panel)',
  borderLeft: '1px solid #000',
  '& header': { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
  '& h2': {
    margin: 0,
    fontFamily: 'var(--font-label)',
    fontSize: '22px',
    fontWeight: 700,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  '& h3': {
    margin: '20px 0 8px',
    fontFamily: 'var(--font-label)',
    fontSize: '16px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--text)',
  },
  '& p': { margin: 0, color: '#c9ccc6', fontSize: '14px', lineHeight: 1.5 },
  '& .close': {
    display: 'grid',
    placeItems: 'center',
    width: '30px',
    height: '30px',
    border: 0,
    borderRadius: '4px',
    background: 'transparent',
    color: 'var(--dim)',
  },
  '& .close:hover': { background: 'var(--key)', color: 'var(--text)' },
  '& dl': { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0, fontSize: '14px' },
  '& dt': { justifySelf: 'start' },
  '& dd': { margin: 0, color: '#c9ccc6' },
  '& kbd': {
    display: 'inline-block',
    minWidth: '22px',
    padding: '1px 6px',
    border: '1px solid #000',
    borderBottomWidth: '2px',
    borderRadius: '3px',
    background: 'var(--key)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  '& .note': { marginTop: '10px', color: 'var(--dim)', fontSize: '13px' },
  '& .languages': { display: 'flex', gap: '4px' },
  '& form': { display: 'flex', gap: '6px', marginBottom: '14px' },
  '& form input': {
    flex: '1 1 auto',
    minWidth: 0,
    height: '32px',
    padding: '0 10px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: '#0c0d0e',
  },
  '& ul': { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' },
  '& li': { display: 'flex', alignItems: 'center', gap: '8px' },
  '& li .open': {
    flex: '1 1 auto',
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 10px',
    border: 0,
    borderRadius: '4px',
    background: 'transparent',
    textAlign: 'left',
  },
  '& li .open:hover': { background: 'var(--key)' },
  '& li .count': { color: 'var(--dim)', fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '& .danger': { marginTop: '16px' },
})

const KEYS: [string, MessageKey][] = [
  ['1–9', 'help.k.air'],
  ['⇧ 1–9', 'help.k.main'],
  ['L', 'help.k.layout'],
  ['C', 'help.k.chat'],
  ['S', 'help.k.sync'],
  ['A', 'help.k.ad'],
  ['M', 'help.k.mute'],
  ['F', 'help.k.full'],
  ['T', 'help.k.cut'],
  ['Alt', 'help.k.listen'],
  ['/', 'help.k.add'],
  ['B', 'help.k.library'],
  ['P', 'help.k.pip'],
  ['?', 'help.k.help'],
]

export function HelpSheet(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  const close = () => {
    store.ui.helpOpen = false
    store.changed(false)
  }
  return () => (
    <section role="dialog" aria-labelledby="help-title" mix={sheetStyle}>
      <header>
        <h2 id="help-title">{t('help.title')}</h2>
        <button type="button" class="close" aria-label={t('help.close')} mix={on('click', close)}>
          <Icon icon={X} />
        </button>
      </header>
      <h3>{t('help.keys')}</h3>
      <dl>
        {KEYS.map(([keys, label]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
      <p class="note">{t('help.focusNote')}</p>
      <h3>{t('help.ads')}</h3>
      <p>{t('help.adsText')}</p>
      <h3>{t('help.background')}</h3>
      <p>{t('help.backgroundText')}</p>
      <h3>{t('help.platforms')}</h3>
      <p>{t('help.platformsText')}</p>
      <h3>{t('help.language')}</h3>
      <div class="languages">
        {(['en', 'fr'] as Locale[]).map((code) => (
          <button
            key={code}
            type="button"
            aria-pressed={locale === code}
            data-tone="white"
            mix={[
              keyStyle,
              on('click', () => {
                setLocale(code)
                store.changed(false)
              }),
            ]}
          >
            {code === 'en' ? 'English' : 'Français'}
          </button>
        ))}
      </div>
    </section>
  )
}
