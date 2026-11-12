import {
  CircleHelp,
  FastForward,
  FolderOpen,
  Link2,
  MegaphoneOff,
  MessagesSquare,
  Pause,
  Play,
  Plus,
  Rewind,
  Timer,
} from 'lucide'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'
import type { Store } from '../app/store.ts'
import type { AudioMode, LayoutMode } from '../core/types.ts'
import { t } from '../i18n/index.ts'
import { capabilities, parseSource } from '../platforms/parse.ts'
import { Fader, groupStyle, Key, keyStyle } from './controls.tsx'
import { Icon } from './Icon.tsx'

const consoleStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  rowGap: '10px',
  padding: '10px 14px 12px',
  background: 'linear-gradient(#17191c, var(--panel))',
  borderTop: '1px solid #000',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
  overflowX: 'auto',
  '& .busses': {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    alignItems: 'center',
    columnGap: '10px',
    rowGap: '6px',
  },
  '& .bus-label': {
    fontFamily: 'var(--font-label)',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--dim)',
    textAlign: 'right',
  },
  '& .keys': { display: 'flex', gap: '4px' },
  '& .keys button': { minWidth: '28px', padding: '0 6px', fontFamily: 'var(--font-mono)', fontSize: '13px' },
  // Paired keys (cut/mix, modes, layouts) stack in two rows like a hardware panel, to keep the console on one line.
  '& .stack': { display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(2, auto)', gap: '4px' },
  '& .hint': { color: 'var(--dim)', fontSize: '13px', fontFamily: 'var(--font-label)', letterSpacing: '0.04em' },
  '& .push': { marginLeft: 'auto' },
  '& fieldset.keys': { display: 'flex', gap: '4px' },
})

const inputStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  '& input': {
    width: 'clamp(170px, 15vw, 300px)',
    height: '34px',
    padding: '0 12px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: '#0c0d0e',
    boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.8)',
    fontSize: '14px',
  },
  '& input[aria-invalid="true"]': { borderColor: 'var(--pgm)' },
  '& input:focus-visible': { outlineOffset: '0' },
})

const errorStyle = css({
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: '14px',
  maxWidth: '420px',
  padding: '8px 12px',
  borderRadius: '4px',
  background: '#2a1210',
  color: '#ffd9d6',
  fontSize: '14px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
})

export function Console(handle: Handle<{ store: Store; inputRef: (node: HTMLInputElement) => void }>) {
  const { store } = handle.props
  let draft = ''
  let invalid = false
  const keepInput = ref((node: HTMLInputElement) => handle.props.inputRef(node))

  const submit = () => {
    const lines = draft
      .split(/[\s,]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    const sources = lines.map(parseSource)
    if (!lines.length) return
    if (sources.some((source) => !source)) {
      invalid = true
      handle.update()
      return
    }
    store.addMany(sources as NonNullable<(typeof sources)[number]>[])
    draft = ''
    invalid = false
    handle.update()
  }

  return () => {
    const { session } = store
    const tiles = session.tiles
    const mix = store.mix()
    const focus = store.effectiveFocus()
    const seekable = tiles.some((tile) => capabilities(tile.source).seek)
    const layouts: [LayoutMode, string][] = [
      ['grid', t('layout.grid')],
      ['focus', t('layout.focus')],
      ['theater', t('layout.theater')],
    ]
    const modes: [AudioMode, string][] = [
      ['solo', t('console.solo')],
      ['mix', t('console.mixMode')],
      ['manual', t('console.manual')],
    ]
    return (
      <section class="console" aria-label={t('console.label')} style={{ position: 'relative' }} mix={consoleStyle}>
        {invalid && (
          <p role="alert" mix={errorStyle}>
            {t('input.invalid')}
          </p>
        )}
        <div mix={groupStyle}>
          <label class="silk" for="source-input">
            {t('input.label')}
          </label>
          <form
            mix={[
              inputStyle,
              on('submit', (event) => {
                event.preventDefault()
                submit()
              }),
            ]}
          >
            <input
              id="source-input"
              type="text"
              inputMode="url"
              autocomplete="off"
              spellcheck={false}
              placeholder={t('input.placeholder')}
              value={draft}
              aria-invalid={invalid}
              mix={[
                keepInput,
                on('input', (event) => {
                  draft = event.currentTarget.value
                  if (invalid) invalid = false
                  handle.update()
                }),
              ]}
            />
            <button type="submit" aria-label={t('input.add')} title={t('input.add')} mix={keyStyle}>
              <Icon icon={Plus} />
            </button>
          </form>
        </div>

        <div mix={groupStyle}>
          {tiles.length ? (
            <div class="busses">
              <span class="bus-label">{t('console.pgm')}</span>
              <fieldset class="keys" aria-label={t('console.pgm')}>
                {tiles.map((tile, index) => (
                  <Key
                    key={tile.id}
                    label={String(index + 1)}
                    title={`${index + 1}. ${store.label(tile.id)}`}
                    ariaLabel={`${t('tile.onAir')}: ${store.label(tile.id)}`}
                    pressed={mix.onAir === tile.id}
                    tone={mix.onAir === tile.id && mix.covering ? 'amber' : 'red'}
                    onPress={() => store.onAir(tile.id)}
                  />
                ))}
              </fieldset>
              <span class="bus-label">{t('console.main')}</span>
              <fieldset class="keys" aria-label={t('console.main')}>
                {tiles.map((tile, index) => (
                  <Key
                    key={tile.id}
                    label={String(index + 1)}
                    title={`${index + 1}. ${store.label(tile.id)}`}
                    ariaLabel={`${t('tile.main')}: ${store.label(tile.id)}`}
                    pressed={focus === tile.id && session.layout !== 'grid'}
                    tone="green"
                    onPress={() => store.setMain(tile.id)}
                  />
                ))}
              </fieldset>
            </div>
          ) : (
            <span class="hint">{t('console.empty')}</span>
          )}
        </div>

        <div mix={groupStyle}>
          <span class="silk">{t('console.transition')}</span>
          <fieldset class="stack" aria-label={t('console.transition')}>
            <Key
              label={t('console.cut')}
              pressed={session.transition === 'cut'}
              onPress={() => store.setTransition('cut')}
            />
            <Key
              label={t('console.mix')}
              pressed={session.transition === 'mix'}
              onPress={() => store.setTransition('mix')}
            />
          </fieldset>
        </div>

        <div mix={groupStyle}>
          <span class="silk">{t('console.mode')}</span>
          <fieldset class="stack" aria-label={t('console.mode')}>
            {modes.map(([mode, label]) => (
              <Key
                key={mode}
                label={label}
                pressed={session.audioMode === mode}
                onPress={() => store.setAudioMode(mode)}
              />
            ))}
          </fieldset>
        </div>

        <div mix={groupStyle}>
          <span class="silk">
            {session.audioMode === 'mix' ? `${t('console.master')} · ${t('console.duck')}` : t('console.master')}
          </span>
          <div class="row">
            <Fader value={session.master} label={t('console.master')} onChange={(value) => store.setMaster(value)} />
            {session.audioMode === 'mix' && (
              <Fader
                value={session.duck}
                label={t('console.duck')}
                size="small"
                onChange={(value) => store.setDuck(value)}
              />
            )}
          </div>
        </div>

        {session.audioMode === 'manual' && tiles.length > 0 && (
          <div mix={groupStyle}>
            <span class="silk">{t('console.manual')}</span>
            <div class="row">
              {tiles.map((tile, index) =>
                capabilities(tile.source).volume ? (
                  <span key={tile.id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span class="mono" style={{ fontSize: '12px', color: 'var(--dim)' }}>
                      {index + 1}
                    </span>
                    <Fader
                      size="small"
                      value={tile.muted ? 0 : tile.volume}
                      label={t('tile.volume', { name: store.label(tile.id) })}
                      onChange={(value) => store.setVolume(tile.id, value)}
                    />
                  </span>
                ) : null,
              )}
            </div>
          </div>
        )}

        <div mix={groupStyle}>
          <span class="silk">{t('console.layout')}</span>
          <fieldset class="stack" aria-label={t('console.layout')}>
            {layouts.map(([layout, label]) => (
              <Key
                key={layout}
                label={label}
                pressed={session.layout === layout}
                onPress={() => store.setLayout(layout)}
              />
            ))}
          </fieldset>
        </div>

        {seekable && (
          <div mix={groupStyle}>
            <span class="silk">{t('console.replay')}</span>
            <div class="stack">
              <Key
                label={<Icon icon={Rewind} />}
                ariaLabel={t('console.back')}
                title={t('console.back')}
                onPress={() => store.seekAll(-10)}
              />
              <Key
                label={<Icon icon={Play} />}
                ariaLabel={t('console.playAll')}
                title={t('console.playAll')}
                onPress={() => store.playAll()}
              />
              <Key
                label={<Icon icon={Pause} />}
                ariaLabel={t('console.pauseAll')}
                title={t('console.pauseAll')}
                onPress={() => store.pauseAll()}
              />
              <Key
                label={<Icon icon={FastForward} />}
                ariaLabel={t('console.forward')}
                title={t('console.forward')}
                onPress={() => store.seekAll(10)}
              />
            </div>
          </div>
        )}

        <div mix={groupStyle} class="push">
          <span class="silk">{t('console.tools')}</span>
          <div class="stack">
            <Key
              label={<Icon icon={Timer} />}
              ariaLabel={t('console.sync')}
              title={`${t('console.sync')} (S)`}
              pressed={store.ui.syncOpen}
              tone="amber"
              disabled={tiles.length < 2}
              onPress={() => store.openSync(!store.ui.syncOpen)}
            />
            <Key
              label={<Icon icon={MegaphoneOff} />}
              ariaLabel={t('console.adSwitch')}
              title={`${t('console.adSwitch')}: ${t('console.adSwitchHint')}`}
              pressed={session.adSwitch}
              tone="amber"
              onPress={() => store.setAdSwitch(!session.adSwitch)}
            />
            <Key
              label={<Icon icon={MessagesSquare} />}
              ariaLabel={t('console.chat')}
              title={`${t('console.chat')} (C)`}
              pressed={session.chatOpen}
              onPress={() => store.toggleChat()}
            />
            <Key
              label={<Icon icon={FolderOpen} />}
              ariaLabel={t('console.library')}
              title={`${t('console.library')} (B)`}
              pressed={store.ui.libraryOpen}
              onPress={() => store.openLibrary()}
            />
            <Key
              label={<Icon icon={Link2} />}
              ariaLabel={t('console.share')}
              title={t('console.share')}
              disabled={!tiles.length}
              onPress={() => store.copyLink()}
            />
            <Key
              label={<Icon icon={CircleHelp} />}
              ariaLabel={t('console.help')}
              title={`${t('console.help')} (?)`}
              pressed={store.ui.helpOpen}
              onPress={() => {
                store.ui.helpOpen = !store.ui.helpOpen
                store.ui.libraryOpen = false
                store.changed(false)
              }}
            />
          </div>
        </div>
      </section>
    )
  }
}
