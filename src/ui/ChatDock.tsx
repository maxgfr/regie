import { Settings2, X } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'
import type { Store } from '../app/store.ts'
import { type ChatMessage, emoteUrl, segments } from '../chat/irc.ts'
import { t } from '../i18n/index.ts'
import { chatUrl } from '../platforms/embed.ts'
import { capabilities, sourceName } from '../platforms/parse.ts'
import { switchStyle } from './controls.tsx'
import { Icon } from './Icon.tsx'

const CHANNEL_COLORS = ['#5ac8fa', '#ffb020', '#c58cff', '#2fd36b', '#ff7aa8', '#f5f06a', '#7ae0d4', '#ff9a52']

const dockStyle = css({
  width: 'clamp(280px, 24vw, 380px)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--panel)',
  borderLeft: '1px solid #000',
  '& .head': {
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    padding: '6px 6px 0',
    borderBottom: '1px solid #000',
    background: '#111315',
  },
  '& .tabs': { display: 'flex', gap: '2px', overflowX: 'auto', flex: '1 1 auto', minWidth: 0 },
  '& .tab': {
    flex: 'none',
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '6px 10px',
    border: 0,
    borderRadius: '4px 4px 0 0',
    background: 'transparent',
    color: 'var(--dim)',
    fontFamily: 'var(--font-label)',
    fontWeight: 600,
    fontSize: '14px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  '& .tab:hover': { color: 'var(--text)' },
  '& .tab[aria-selected="true"]': {
    background: 'var(--panel)',
    color: 'var(--text)',
    boxShadow: 'inset 0 2px 0 var(--amber)',
  },
  '& .icon-button': {
    display: 'grid',
    placeItems: 'center',
    width: '30px',
    border: 0,
    borderRadius: '4px',
    background: 'transparent',
    color: 'var(--dim)',
  },
  '& .icon-button:hover, & .icon-button[aria-expanded="true"]': { color: 'var(--text)', background: 'var(--key)' },
  '& .body': { position: 'relative', flex: '1 1 auto', minHeight: 0 },
  '& .frame': { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#18181b' },
  '& .frame[hidden]': { display: 'none' },
  '& .settings': {
    display: 'grid',
    gap: '14px',
    padding: '14px',
    borderBottom: '1px solid #000',
    background: '#111315',
  },
  '& .settings input[type="text"]': {
    width: '100%',
    marginTop: '6px',
    height: '32px',
    padding: '0 10px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: '#0c0d0e',
  },
  '& .note': { padding: '16px', color: 'var(--dim)', fontSize: '14px' },
})

const logStyle = css({
  position: 'absolute',
  inset: 0,
  overflowY: 'auto',
  padding: '8px 0',
  fontSize: '14px',
  lineHeight: 1.4,
  overflowWrap: 'anywhere',
  '& .message': { padding: '2px 12px' },
  '& .message[data-hit="true"]': { background: 'rgba(255,176,32,0.14)', boxShadow: 'inset 2px 0 0 var(--amber)' },
  '& .channel': {
    display: 'inline-block',
    marginRight: '6px',
    padding: '0 4px',
    borderRadius: '2px',
    color: '#000',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    verticalAlign: '1px',
  },
  '& .user': { fontWeight: 600 },
  '& img': { height: '22px', verticalAlign: 'middle', margin: '-4px 0' },
  '& .status': { padding: '12px', color: 'var(--dim)' },
})

function readableColor(color: string): string {
  // Twitch colours are chosen for a white or dark page; lift the darkest ones on our ground.
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match?.[1]) return '#c9ccc6'
  const value = Number.parseInt(match[1], 16)
  const r = value >> 16
  const g = (value >> 8) & 255
  const b = value & 255
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance < 90 ? `color-mix(in srgb, ${color} 55%, white)` : color
}

/** The merged Twitch chat, each message already held back by the store to match its stream. */
function MergedLog(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let list: HTMLElement | undefined
  let pinned = true
  store.addEventListener(
    'chat',
    () => {
      handle.update().then(() => {
        if (list && pinned) list.scrollTop = list.scrollHeight
      })
    },
    { signal: handle.signal },
  )
  const keep = ref((node: HTMLElement) => {
    list = node
  })

  return () => {
    const { session } = store
    const channels = session.tiles.filter((tile) => capabilities(tile.source).liveChat).map((tile) => tile.source.id)
    const words = session.keywords.map((word) => word.toLowerCase())
    const hit = (message: ChatMessage) => words.some((word) => message.text.toLowerCase().includes(word))
    const color = (channel: string) => CHANNEL_COLORS[Math.max(0, channels.indexOf(channel)) % CHANNEL_COLORS.length]
    return (
      <div
        role="log"
        aria-live="off"
        aria-label={t('chat.merged')}
        mix={[
          logStyle,
          keep,
          on('scroll', (event) => {
            const node = event.currentTarget
            pinned = node.scrollHeight - node.scrollTop - node.clientHeight < 40
          }),
        ]}
      >
        {!channels.length ? (
          <p class="status">{t('chat.noTwitch')}</p>
        ) : !store.ui.chatConnected && !store.chatLog.length ? (
          <p class="status">{t('chat.connecting')}</p>
        ) : !store.chatLog.length ? (
          <p class="status">{t('chat.empty')}</p>
        ) : null}
        {store.chatLog.map((message) => (
          <div key={message.id} class="message" data-hit={words.length > 0 && hit(message)}>
            {channels.length > 1 && (
              <span class="channel" style={{ background: color(message.channel) }}>
                {message.channel}
              </span>
            )}
            <span class="user" style={{ color: readableColor(message.color) }}>
              {message.user}
            </span>
            <span>: </span>
            {segments(message).map((part, index) =>
              'emote' in part ? (
                <img key={index} src={emoteUrl(part.emote)} alt={part.name} title={part.name} loading="lazy" />
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </div>
        ))}
      </div>
    )
  }
}

export function ChatDock(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let settingsOpen = false
  const host = location.hostname || 'localhost'
  /** Chat frames that were opened once stay mounted (hidden), so switching tabs doesn't reload them. */
  const opened = new Set<string>()

  return () => {
    const { session, ui } = store
    const frames = store.chatTiles()
    let tab = ui.chatTab
    const valid = tab === 'merged' ? session.liveChat : frames.some((tile) => tile.id === tab)
    if (!valid) tab = session.liveChat ? 'merged' : (frames[0]?.id ?? 'merged')
    if (tab !== 'merged') opened.add(tab)
    for (const id of opened) if (!frames.some((tile) => tile.id === id)) opened.delete(id)

    return (
      <aside aria-label={t('chat.title')} mix={dockStyle}>
        <div class="head">
          <div class="tabs" role="tablist" aria-label={t('chat.tabs')}>
            {session.liveChat && (
              <button
                type="button"
                role="tab"
                class="tab"
                aria-selected={tab === 'merged'}
                mix={on('click', () => store.setChatTab('merged'))}
              >
                {t('chat.merged')}
              </button>
            )}
            {frames.map((tile) => (
              <button
                key={tile.id}
                type="button"
                role="tab"
                class="tab"
                aria-selected={tab === tile.id}
                title={store.label(tile.id)}
                mix={on('click', () => store.setChatTab(tile.id))}
              >
                {sourceName(tile.source)}
              </button>
            ))}
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label={t('chat.settings')}
            title={t('chat.settings')}
            aria-expanded={settingsOpen}
            mix={on('click', () => {
              settingsOpen = !settingsOpen
              handle.update()
            })}
          >
            <Icon icon={Settings2} />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label={t('chat.close')}
            title={t('chat.close')}
            mix={on('click', () => store.toggleChat(false))}
          >
            <Icon icon={X} />
          </button>
        </div>
        {settingsOpen && (
          <div class="settings">
            <label mix={switchStyle}>
              <input
                type="checkbox"
                checked={session.liveChat}
                mix={on('change', (event) => store.setLiveChat(event.currentTarget.checked))}
              />
              <span>
                <strong>{t('chat.liveChat')}</strong>
                <small>{t('chat.liveChatHint')}</small>
              </span>
            </label>
            <label mix={switchStyle}>
              <input
                type="checkbox"
                checked={session.antiSpoiler}
                disabled={!session.liveChat}
                mix={on('change', (event) => store.setAntiSpoiler(event.currentTarget.checked))}
              />
              <span>
                <strong>{t('chat.antiSpoiler')}</strong>
                <small>{t('chat.antiSpoilerHint')}</small>
              </span>
            </label>
            <label mix={switchStyle}>
              <input
                type="checkbox"
                checked={session.autoDirector}
                disabled={!session.liveChat}
                mix={on('change', (event) => store.setAutoDirector(event.currentTarget.checked))}
              />
              <span>
                <strong>{t('chat.autoDirector')}</strong>
                <small>{t('chat.autoDirectorHint')}</small>
              </span>
            </label>
            <label>
              <strong style={{ fontWeight: 500 }}>{t('chat.keywords')}</strong>
              <input
                type="text"
                value={session.keywords.join(', ')}
                placeholder={t('chat.keywordsPlaceholder')}
                disabled={!session.liveChat}
                mix={on('change', (event) => store.setKeywords(event.currentTarget.value))}
              />
            </label>
          </div>
        )}
        <div class="body">
          {tab === 'merged' && session.liveChat && <MergedLog store={store} />}
          {!session.liveChat && !frames.length && <p class="note">{t('chat.none')}</p>}
          {frames.map((tile) => {
            const url = chatUrl(tile.source, host)
            if (!url || !opened.has(tile.id)) return null
            return (
              <iframe
                key={tile.id}
                class="frame"
                src={url}
                title={`${t('chat.title')} ${sourceName(tile.source)}`}
                hidden={tab !== tile.id}
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-storage-access-by-user-activation"
              />
            )
          })}
        </div>
      </aside>
    )
  }
}
