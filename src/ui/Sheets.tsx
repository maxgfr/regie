import { X } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'
import type { Store } from '../app/store.ts'
import { normalizeRelayBase } from '../core/relay.ts'
import { type Locale, locale, type MessageKey, setLocale, t } from '../i18n/index.ts'
import { keyStyle, switchStyle } from './controls.tsx'
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

const relayStyle = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)',
  gap: '8px',
  margin: '10px 0 8px',
  '& label': { display: 'grid', gap: '4px', minWidth: 0 },
  '& label > span': { color: 'var(--dim)', fontSize: '13px' },
  '& input': {
    minWidth: 0,
    height: '32px',
    padding: '0 10px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: '#0c0d0e',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
  },
  '& .status': {
    gridColumn: '1 / -1',
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    color: 'var(--dim)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.4,
  },
  // A lamp next to the words, like a console status light: the state is always written too.
  '& .status::before': {
    content: '""',
    flex: 'none',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--line)',
    transform: 'translateY(-1px)',
  },
  '& .status[data-status="up"]': { color: 'var(--pvw)' },
  '& .status[data-status="up"]::before': { background: 'var(--pvw)' },
  '& .status[data-status="down"]': { color: 'var(--amber)' },
  '& .status[data-status="down"]::before': { background: 'var(--amber)' },
  '& .status small': { display: 'block', color: 'var(--dim)', fontFamily: 'var(--font-ui)', fontSize: '13px' },
})

const commandStyle = css({
  padding: '1px 5px',
  borderRadius: '3px',
  background: 'var(--key)',
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  whiteSpace: 'nowrap',
})

/** The address and key of the viewer's relay, and whether it answers. Saved when a field is committed. */
function RelaySettings(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let url = store.relay.url
  let key = store.relay.key
  let seen = `${url}\n${key}`
  const commit = () => store.setRelay(url, key)
  return () => {
    const { relay } = store
    // Settings changed elsewhere (a backup import): show them.
    if (`${relay.url}\n${relay.key}` !== seen) {
      seen = `${relay.url}\n${relay.key}`
      url = relay.url
      key = relay.key
    }
    const invalid = relay.status === 'down' && normalizeRelayBase(relay.url) === null
    // Without a server relay up, the Regie extension plays Twitch: the "official players" lines would be wrong.
    const viaExtension = relay.via === 'extension'
    const status =
      relay.status === 'up'
        ? [t('relay.up'), relay.ytdlp && `yt-dlp ${relay.ytdlp}`, relay.ffmpeg && `ffmpeg ${relay.ffmpeg}`]
            .filter(Boolean)
            .join(' · ')
        : relay.status === 'checking'
          ? t('relay.checking')
          : relay.status === 'down'
            ? t(invalid ? 'relay.invalid' : viaExtension ? 'relay.downExtension' : 'relay.down')
            : t('relay.off')
    const [before, after] = t('relay.run').split('{command}')
    return (
      <div>
        <p>{t('relay.text')}</p>
        <fieldset mix={relayStyle}>
          <legend class="sr-only">{t('relay.title')}</legend>
          <label>
            <span>{t('relay.url')}</span>
            <input
              type="text"
              inputMode="url"
              autocomplete="off"
              spellcheck={false}
              placeholder="http://localhost:7878"
              value={url}
              mix={[
                on('input', (event) => {
                  url = event.currentTarget.value
                }),
                on('change', commit),
              ]}
            />
          </label>
          <label>
            <span>{t('relay.key')}</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={key}
              mix={[
                on('input', (event) => {
                  key = event.currentTarget.value
                }),
                on('change', commit),
              ]}
            />
          </label>
          {!(viaExtension && relay.status === 'off') && (
            <p class="status" data-status={relay.status} role="status">
              <span>
                {status}
                {relay.status === 'up' && !relay.ffmpeg && <small>{t('relay.noFfmpeg')}</small>}
              </span>
            </p>
          )}
          {viaExtension && (
            <p class="status" data-status="up" role="status">
              <span>{t('relay.extension')}</span>
            </p>
          )}
        </fieldset>
        <p class="note">
          {before}
          <code mix={commandStyle}>bun run relay</code>
          {after}
        </p>
      </div>
    )
  }
}

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
      <label mix={switchStyle} style={{ marginBottom: '10px' }}>
        <input
          type="checkbox"
          checked={store.session.adReload}
          mix={on('change', (event) => store.setAdReload(event.currentTarget.checked))}
        />
        <span>
          <strong>{t('help.adReload')}</strong>
          <small>{t('help.adReloadHint')}</small>
        </span>
      </label>
      <p>{t('help.adsText')}</p>
      <h3>{t('relay.title')}</h3>
      <RelaySettings store={store} />
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
