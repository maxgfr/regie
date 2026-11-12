import { Expand, ExternalLink, Megaphone, Monitor, Radio, Star, Volume2, VolumeX, X } from 'lucide'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'
import { isFavorite } from '../app/library.ts'
import type { Store } from '../app/store.ts'
import { computeLayout, minimumScale, type Placed } from '../core/layout.ts'
import { seconds, t } from '../i18n/index.ts'
import { capabilities, platformLabel, sourcePage } from '../platforms/parse.ts'
import { Icon } from './Icon.tsx'

const UMD = 28
const GAP = 8

const stageStyle = css({
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  outline: 'none',
  // Iframes swallow drag events: while a tile is dragged, they let the stage see the pointer.
  '&[data-dragging="true"] .player': { pointerEvents: 'none' },
})

export function Stage(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let width = 0
  let height = 0
  let dragging: string | null = null

  const measure = ref((node: HTMLElement, signal) => {
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const nextWidth = Math.floor(entry.contentRect.width)
      const nextHeight = Math.floor(entry.contentRect.height)
      if (nextWidth === width && nextHeight === height) return
      // Re-render on the next frame: changing the layout inside the observer callback makes the
      // browser report a "ResizeObserver loop".
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        width = nextWidth
        height = nextHeight
        handle.update()
      })
    })
    observer.observe(node)
    signal.addEventListener('abort', () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    })
  })

  return () => {
    const { session } = store
    // During a line check, the monitor being started takes the main slot of a "main + strip" layout.
    const warming = store.ui.warmup?.id ?? null
    const focus = warming ?? store.effectiveFocus()
    const placed = computeLayout({
      tiles: session.tiles.map((tile) => ({ id: tile.id, aspect: capabilities(tile.source).aspect })),
      width: width - GAP * 2,
      height: height - GAP * 2,
      mode: warming ? 'focus' : session.layout,
      focusId: focus,
      gap: GAP,
      chrome: UMD,
    })
    const byId = new Map(placed.map((p) => [p.id, p]))
    const mix = store.mix()
    return (
      <section
        id="stage"
        tabIndex={-1}
        aria-label={t('console.layout')}
        data-dragging={dragging !== null}
        mix={[stageStyle, measure]}
      >
        {store.domOrder.map((id) => {
          const index = session.tiles.findIndex((tile) => tile.id === id)
          return (
            <TileView
              key={id}
              store={store}
              id={id}
              number={index + 1}
              rect={byId.get(id)}
              onAir={mix.onAir === id}
              covering={mix.onAir === id && mix.covering}
              main={focus === id && session.tiles.length > 1}
              dragging={() => dragging}
              setDragging={(value) => {
                dragging = value
                handle.update()
              }}
            />
          )
        })}
      </section>
    )
  }
}

const tileStyle = css({
  position: 'absolute',
  left: `${GAP}px`,
  top: `${GAP}px`,
  display: 'flex',
  flexDirection: 'column',
  background: '#000',
  boxShadow: '0 0 0 1px var(--line)',
  transition: 'transform 380ms var(--ease-out), width 380ms var(--ease-out), height 380ms var(--ease-out)',
  // The first placement is a cut, not a glide from the corner.
  '&[data-placed="false"]': { transition: 'none' },
  '&[data-overlay="true"]': { zIndex: 2 },
  '&[data-hidden="true"]': { visibility: 'hidden' },
  '&[data-drop="true"]': { boxShadow: '0 0 0 2px var(--amber)' },
  '& .screen': { position: 'relative', flex: '1 1 auto', overflow: 'hidden', background: '#000' },
  '& .player': { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0' },
  // Nothing may be drawn over a player: Twitch refuses to autoplay a player it can't fully see.
  // The tally is a ring around the monitor, and every other state lives in the label strip.
  '&[data-tally="pgm"]': { boxShadow: '0 0 0 3px var(--pgm)' },
  '&[data-tally="pvw"]': { boxShadow: '0 0 0 3px var(--pvw)' },
  '&[data-ad="true"]': { boxShadow: '0 0 0 3px var(--amber)' },
  '&[data-ad="true"][data-tally="pgm"]': { boxShadow: '0 0 0 3px var(--amber)' },
  '&:fullscreen .umd': { display: 'none' },
})

const umdStyle = css({
  flex: `0 0 ${UMD}px`,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '0 4px 0 0',
  background: '#101214',
  borderTop: '1px solid #000',
  fontFamily: 'var(--font-label)',
  fontSize: '14px',
  minWidth: 0,
  '& .num': {
    flex: 'none',
    display: 'grid',
    placeItems: 'center',
    width: '26px',
    height: '100%',
    background: '#1d2023',
    color: 'var(--dim)',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    cursor: 'grab',
  },
  '&[data-tally="pgm"] .num': { background: 'var(--pgm)', color: '#fff' },
  '&[data-tally="pvw"] .num': { background: 'var(--pvw)', color: '#04150a' },
  '& .name': {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    letterSpacing: '0.02em',
  },
  '&[data-channel="true"] .name': { textTransform: 'uppercase' },
  '& .platform': { color: 'var(--dim)', fontSize: '13px', flex: 'none' },
  '& .spacer': { flex: '1 1 auto' },
  '& .tags': { display: 'flex', gap: '4px', flex: 'none', alignItems: 'center' },
  '& .tag': {
    padding: '1px 6px',
    borderRadius: '2px',
    fontSize: '12px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    lineHeight: '16px',
  },
  '& .tag[data-kind="air"]': { background: 'var(--pgm)', color: '#fff' },
  '& .tag[data-kind="main"]': { background: 'var(--pvw)', color: '#04150a' },
  '& .tag[data-kind="ad"]': { background: 'var(--amber)', color: '#1a1000' },
  '& .tag[data-kind="hype"]': { background: 'var(--text)', color: '#000' },
  '& .tag[data-kind="start"]': {
    background: 'transparent',
    color: 'var(--amber)',
    boxShadow: 'inset 0 0 0 1px var(--amber)',
  },
  '& .measure': {
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '12px',
    color: 'var(--amber)',
    whiteSpace: 'nowrap',
  },
  '& .measure[data-quiet="true"]': { color: 'var(--dim)' },
  '& .tools': { display: 'flex', gap: '1px', flex: 'none' },
  '& .tools button, & .tools a': {
    display: 'grid',
    placeItems: 'center',
    width: '26px',
    height: '24px',
    border: 0,
    borderRadius: '3px',
    background: 'transparent',
    color: 'var(--dim)',
  },
  '& .tools button:hover, & .tools a:hover': { background: 'var(--key-hover)', color: 'var(--text)' },
  '& .tools [aria-pressed="true"][data-tone="red"]': { color: 'var(--pgm-ink)' },
  '& .tools [aria-pressed="true"][data-tone="green"]': { color: 'var(--pvw)' },
  '& .tools [aria-pressed="true"][data-tone="amber"]': { color: 'var(--amber)' },
  '& [data-optional]': {},
  '&[data-compact="true"] [data-optional]': { display: 'none' },
  '&[data-tiny="true"] .platform, &[data-tiny="true"] .measure': { display: 'none' },
})

/** A VU meter of ten segments, lit from the left: green, then amber, then red. */
const meterStyle = css({
  flex: 'none',
  display: 'grid',
  gridTemplateColumns: 'repeat(10, 4px)',
  gap: '1px',
  height: '10px',
  '& i': { background: '#23272b', borderRadius: '1px' },
  '& i[data-on="true"]': { background: 'var(--pvw)' },
  '& i[data-on="true"]:nth-child(n+7)': { background: 'var(--amber)' },
  '& i[data-on="true"]:nth-child(n+9)': { background: 'var(--pgm)' },
})

/** Chat activity of one stream, refreshed every second without re-rendering the tile. */
function Meter(handle: Handle<{ store: Store; id: string }>) {
  const { store, id } = handle.props
  store.addEventListener('tick', () => handle.update(), { signal: handle.signal })
  return () => {
    const tile = store.tile(id)
    if (!store.session.liveChat || !tile || !capabilities(tile.source).liveChat) return null
    const lit = Math.round(store.meter(id) * 10)
    return (
      <span mix={meterStyle} title={t('tile.badgeHype')} aria-hidden="true" data-optional>
        {Array.from({ length: 10 }, (_, index) => (
          <i key={index} data-on={index < lit} />
        ))}
      </span>
    )
  }
}

const markStyle = css({
  flex: 'none',
  height: '22px',
  padding: '0 12px',
  border: '1px solid var(--amber)',
  borderRadius: '3px',
  background: '#1a1408',
  color: 'var(--amber)',
  fontFamily: 'var(--font-label)',
  fontSize: '13px',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'crosshair',
  '&[data-marked="true"]': { background: 'var(--amber)', color: '#1a1000' },
})

const unembeddableStyle = css({
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeContent: 'center',
  justifyItems: 'center',
  gap: '12px',
  padding: '16px',
  textAlign: 'center',
  color: 'var(--dim)',
  background: '#111315',
  '& a': {
    color: '#1a1000',
    background: 'var(--amber)',
    padding: '6px 12px',
    borderRadius: '4px',
    textDecoration: 'none',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
})

interface TileProps {
  store: Store
  id: string
  number: number
  rect: Placed | undefined
  onAir: boolean
  covering: boolean
  main: boolean
  dragging: () => string | null
  setDragging: (id: string | null) => void
}

function TileView(handle: Handle<TileProps>) {
  const { store, id } = handle.props
  let waiting = false
  store.addEventListener(
    'tick',
    () => {
      if (store.waitingForClick(id) !== waiting) {
        waiting = !waiting
        handle.update()
      }
    },
    { signal: handle.signal },
  )
  let element: HTMLElement | undefined
  let dropTarget = false
  let screen: HTMLElement | undefined
  let attached = false
  // The player is mounted once into an element Regie never re-renders, so it never reloads. It waits until
  // the tile has its real size: a player that starts hidden or tiny refuses to autoplay (Twitch does).
  const mount = ref((node: HTMLElement) => {
    screen = node
  })
  const keep = ref((node: HTMLElement) => {
    element = node
  })

  return () => {
    const { number, rect, onAir, covering, main } = handle.props
    const tile = store.tile(id)
    if (!tile) return <article mix={tileStyle} data-hidden="true" />
    const runtime = store.runtime.get(id)
    const caps = capabilities(tile.source)
    const box = rect ?? { x: 0, y: 0, w: 0, h: 0, overlay: false }
    const screenW = box.w
    const screenH = Math.max(0, box.h - UMD)
    // Twitch refuses to play below 400×300: render it at that size and scale it down.
    const scale = tile.source.platform === 'twitch' ? minimumScale({ x: 0, y: 0, w: screenW, h: screenH }, 400, 300) : 1
    const tally = onAir ? 'pgm' : main ? 'pvw' : 'none'
    const inAd = runtime?.ad.inAd ?? false
    const name = store.label(id)
    const platform = platformLabel(tile.source.platform)
    const takeover = store.ui.takeover?.id === id
    const info = runtime?.info
    const viewers =
      info?.live && info.viewers
        ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(info.viewers)
        : ''
    const favorite = isFavorite(tile.source)
    const measure = tile.delay
      ? t('tile.delay', { s: seconds(tile.delay) })
      : tile.ahead
        ? t('tile.ahead', { s: seconds(tile.ahead) })
        : runtime?.latency
          ? t('tile.latency', { s: seconds(runtime.latency).replace('+', '') })
          : ''
    const syncing = store.ui.syncOpen && tile.source.kind !== 'unembeddable'
    if (!attached && rect && rect.w > 0) {
      handle.queueTask(() => {
        if (attached || !screen) return
        attached = true
        store.attach(id, screen)
        // Twitch only autoplays at 400×300 or more: a smaller monitor gets a line check first.
        const box = screen.getBoundingClientRect()
        if (tile.source.platform === 'twitch' && (box.width < 400 || box.height < 300)) store.warmUp(id)
        handle.update()
      })
    }
    const marked = runtime?.mark !== undefined
    const muted = tile.muted || tile.volume === 0

    return (
      <article
        data-tile={id}
        data-tally={tally}
        data-ad={inAd}
        data-overlay={box.overlay}
        data-hidden={!rect}
        data-placed={attached}
        data-drop={dropTarget}
        aria-label={`${number}. ${name} (${platform})`}
        style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: `${box.w}px`, height: `${box.h}px` }}
        mix={[
          tileStyle,
          keep,
          on('pointerenter', () => store.select(id)),
          on('dragover', (event) => {
            if (!handle.props.dragging() || handle.props.dragging() === id) return
            event.preventDefault()
            if (!dropTarget) {
              dropTarget = true
              handle.update()
            }
          }),
          on('dragleave', () => {
            dropTarget = false
            handle.update()
          }),
          on('drop', (event) => {
            const from = handle.props.dragging()
            dropTarget = false
            if (!from || from === id) return
            event.preventDefault()
            event.stopPropagation()
            handle.props.setDragging(null)
            store.swap(from, id)
          }),
        ]}
      >
        <div class="screen">
          <div
            class="player"
            style={{
              width: `${screenW / scale}px`,
              height: `${screenH / scale}px`,
              transform: scale < 1 ? `scale(${scale})` : 'none',
            }}
            mix={tile.source.kind === 'unembeddable' ? undefined : mount}
          />
          {tile.source.kind === 'unembeddable' && (
            <div mix={unembeddableStyle}>
              <p>{t('tile.unembeddable')}</p>
              <a
                href={tile.source.id}
                target="_blank"
                rel="noopener noreferrer"
                mix={on('click', (event) => {
                  event.preventDefault()
                  window.open(tile.source.id, `regie-${id}`, 'popup,width=480,height=860')
                })}
              >
                {t('tile.openWindow')}
              </a>
            </div>
          )}
        </div>
        <footer
          data-tally={tally}
          data-compact={box.w < 420}
          data-tiny={box.w < 300}
          data-channel={!runtime?.title}
          mix={umdStyle}
        >
          <span
            class="num"
            draggable="true"
            title={t('tile.drag')}
            mix={[
              on('dragstart', (event) => {
                handle.props.setDragging(id)
                event.dataTransfer?.setData('application/x-regie-tile', id)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              }),
              on('dragend', () => handle.props.setDragging(null)),
            ]}
          >
            {number}
          </span>
          <span class="name" title={info?.title ? `${name} · ${info.category ?? ''} · ${info.title}` : name}>
            {name}
          </span>
          <span class="platform">{platform}</span>
          <span class="tags">
            {onAir && (
              <span class="tag" data-kind="air">
                {covering ? t('tile.badgeCover') : t('tile.badgeAir')}
              </span>
            )}
            {main && !onAir && (
              <span class="tag" data-kind="main">
                {t('tile.badgeMain')}
              </span>
            )}
            {inAd && (
              <span class="tag" data-kind="ad">
                {t('tile.badgeAd')}
              </span>
            )}
            {store.waitingForClick(id) && (
              <span class="tag" data-kind="start" title={t('tile.startHint')}>
                {t('tile.badgeStart')}
              </span>
            )}
            {takeover && (
              <span class="tag" data-kind="hype">
                {t('tile.badgeHype')}
              </span>
            )}
          </span>
          <span class="spacer" />
          {syncing && (
            <button type="button" data-marked={marked} mix={[markStyle, on('click', () => store.clap(id))]}>
              {marked ? t('sync.marked') : t('sync.mark', { n: number })}
            </button>
          )}
          <Meter store={store} id={id} />
          {measure && (
            <span class="measure" data-quiet={!tile.delay && !tile.ahead}>
              {measure}
            </span>
          )}
          {viewers && (
            <span class="measure" data-quiet="true" data-optional title={t('tile.viewers', { n: info?.viewers ?? 0 })}>
              {viewers}
            </span>
          )}
          <span class="tools">
            <button
              type="button"
              title={t('tile.onAir')}
              aria-label={t('tile.onAir')}
              aria-pressed={onAir}
              data-tone="red"
              mix={on('click', () => store.onAir(id))}
            >
              <Icon icon={Radio} />
            </button>
            {store.session.tiles.length > 1 && (
              <button
                type="button"
                title={t('tile.main')}
                aria-label={t('tile.main')}
                aria-pressed={main}
                data-tone="green"
                data-optional
                mix={on('click', () => store.setMain(id))}
              >
                <Icon icon={Monitor} />
              </button>
            )}
            {caps.mute && (
              <button
                type="button"
                title={caps.volume ? (muted ? t('tile.unmute') : t('tile.mute')) : t('tile.noVolume', { platform })}
                aria-label={muted ? t('tile.unmute') : t('tile.mute')}
                aria-pressed={muted}
                data-tone="amber"
                mix={on('click', () => store.toggleMute(id))}
              >
                <Icon icon={muted ? VolumeX : Volume2} />
              </button>
            )}
            <button
              type="button"
              title={inAd ? t('tile.adOff') : t('tile.ad')}
              aria-label={inAd ? t('tile.adOff') : t('tile.ad')}
              aria-pressed={inAd}
              data-tone="amber"
              data-optional
              mix={on('click', () => store.toggleAd(id))}
            >
              <Icon icon={Megaphone} />
            </button>
            <button
              type="button"
              title={t('tile.fullscreen')}
              aria-label={t('tile.fullscreen')}
              data-optional
              mix={on('click', () => element?.requestFullscreen?.().catch(() => undefined))}
            >
              <Icon icon={Expand} />
            </button>
            <button
              type="button"
              title={favorite ? t('tile.unfavorite') : t('tile.favorite')}
              aria-label={favorite ? t('tile.unfavorite') : t('tile.favorite')}
              aria-pressed={favorite}
              data-tone="amber"
              data-optional
              mix={on('click', () => {
                store.toggleFavorite(id)
                handle.update()
              })}
            >
              <Icon icon={Star} />
            </button>
            <a
              href={sourcePage(tile.source)}
              target="_blank"
              rel="noopener noreferrer"
              title={t('tile.open', { platform })}
              aria-label={t('tile.open', { platform })}
              data-optional
            >
              <Icon icon={ExternalLink} />
            </a>
            <button
              type="button"
              title={t('tile.remove')}
              aria-label={t('tile.remove')}
              mix={on('click', () => store.remove(id))}
            >
              <Icon icon={X} />
            </button>
          </span>
        </footer>
      </article>
    )
  }
}
