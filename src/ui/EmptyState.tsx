import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'
import type { Store } from '../app/store.ts'
import type { Source } from '../core/types.ts'
import { t } from '../i18n/index.ts'
import { parseSource } from '../platforms/parse.ts'

/** The test card: 75% colour bars, the reverse-blue strip and a pluge, with the identity box in the middle. */
const BARS = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf']
const REVERSE = ['#0000bf', '#131313', '#bf00bf', '#131313', '#00bfbf', '#131313', '#bfbfbf']

const EXAMPLES: { key: 'example.esports' | 'example.chill'; sources: Source[] }[] = [
  {
    key: 'example.esports',
    sources: ['riotgames', 'lck', 'lec', 'valorant', 'eslcs'].map((id) => ({ platform: 'twitch', kind: 'live', id })),
  },
  {
    key: 'example.chill',
    sources: [
      { platform: 'youtube', kind: 'live', id: '4xDzrJKXOOY' },
      { platform: 'twitch', kind: 'live', id: 'lofigirl' },
    ],
  },
]

const cardStyle = css({
  position: 'relative',
  height: '100%',
  display: 'grid',
  gridTemplateRows: '67fr 8fr 25fr',
  overflow: 'hidden',
  '& .bars, & .reverse': { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' },
  '& .pluge': { display: 'grid', gridTemplateColumns: '5fr 5fr 5fr 5fr 1.33fr 1.33fr 1.34fr 5fr' },
  '& .bars, & .reverse, & .pluge': { opacity: 0.38 },
  '& .ident': {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
  },
  '& .ring': {
    position: 'absolute',
    width: 'min(78vh, 70vw)',
    aspectRatio: '1',
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.28)',
    pointerEvents: 'none',
  },
  '& .ring::before, & .ring::after': {
    content: '""',
    position: 'absolute',
    background: 'rgba(255,255,255,0.22)',
  },
  '& .ring::before': { left: '50%', top: 0, bottom: 0, width: '2px', marginLeft: '-1px' },
  '& .ring::after': { top: '50%', left: 0, right: 0, height: '2px', marginTop: '-1px' },
  '& .box': {
    position: 'relative',
    width: 'min(560px, 100%)',
    display: 'grid',
    gap: '18px',
    padding: '28px 32px 26px',
    background: '#000',
    border: '2px solid #e6e8e3',
    boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
  },
  '& h1': {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    fontSize: '56px',
    lineHeight: 1,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
  },
  '& h1 .lamp': {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    background: 'var(--pgm)',
    boxShadow: '0 0 0 3px rgba(255,59,48,0.25), 0 0 18px var(--pgm)',
  },
  '& .lede': { margin: 0, fontSize: '17px', lineHeight: 1.5, maxWidth: '56ch', color: '#d5d8d2' },
  '& form': { display: 'flex', gap: '6px' },
  '& form input': {
    flex: '1 1 auto',
    minWidth: 0,
    height: '42px',
    padding: '0 14px',
    border: '1px solid #3a3f44',
    borderRadius: '4px',
    background: '#0c0d0e',
    fontSize: '15px',
  },
  '& form input[aria-invalid="true"]': { borderColor: 'var(--pgm)' },
  '& form button': {
    flex: 'none',
    height: '42px',
    padding: '0 18px',
    border: '1px solid #000',
    borderRadius: '4px',
    background: 'linear-gradient(#ff5047, #d9261d)',
    color: '#fff',
    fontFamily: 'var(--font-label)',
    fontWeight: 700,
    fontSize: '16px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    boxShadow: '0 1px 10px rgba(255,59,48,0.4)',
  },
  '& .error': { margin: 0, color: '#ffb3ad', fontSize: '14px' },
  '& .examples': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  '& .examples span': { color: 'var(--dim)', fontSize: '14px', marginRight: '4px' },
  '& .examples button': {
    padding: '6px 12px',
    border: '1px solid #3a3f44',
    borderRadius: '4px',
    background: '#15171a',
    fontSize: '14px',
  },
  '& .examples button:hover': { borderColor: 'var(--amber)', color: '#fff' },
  '& .fine': { margin: 0, color: 'var(--dim)', fontSize: '13px', lineHeight: 1.45 },
  '& .platforms': {
    fontFamily: 'var(--font-label)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontSize: '13px',
    color: 'var(--dim)',
  },
  '@media (max-width: 640px)': {
    '& h1': { fontSize: '40px' },
    '& .box': { padding: '20px' },
  },
})

export function EmptyState(handle: Handle<{ store: Store }>) {
  const { store } = handle.props
  let draft = ''
  let invalid = false

  return () => (
    <section aria-labelledby="empty-title" mix={cardStyle}>
      <div class="bars" aria-hidden="true">
        {BARS.map((color) => (
          <span key={color} style={{ background: color }} />
        ))}
      </div>
      <div class="reverse" aria-hidden="true">
        {REVERSE.map((color, index) => (
          <span key={index} style={{ background: color }} />
        ))}
      </div>
      <div class="pluge" aria-hidden="true">
        {['#00214c', '#ffffff', '#32006a', '#131313', '#090909', '#131313', '#1d1d1d', '#131313'].map(
          (color, index) => (
            <span key={index} style={{ background: color }} />
          ),
        )}
      </div>
      <div class="ident">
        <div class="ring" aria-hidden="true" />
        <div class="box">
          <h1 id="empty-title">
            <span class="lamp" aria-hidden="true" />
            {t('empty.title')}
          </h1>
          <p class="lede">{t('empty.lede')}</p>
          <form
            mix={on('submit', (event) => {
              event.preventDefault()
              const parts = draft.split(/[\s,]+/).filter(Boolean)
              const sources = parts.map(parseSource)
              if (!parts.length || sources.some((source) => !source)) {
                invalid = parts.length > 0
                handle.update()
                return
              }
              store.addMany(sources as Source[])
            })}
          >
            <label class="sr-only" for="empty-input">
              {t('input.label')}
            </label>
            <input
              id="empty-input"
              type="text"
              inputMode="url"
              autocomplete="off"
              spellcheck={false}
              placeholder={t('input.placeholder')}
              value={draft}
              aria-invalid={invalid}
              aria-describedby={invalid ? 'empty-error' : undefined}
              mix={on('input', (event) => {
                draft = event.currentTarget.value
                invalid = false
                handle.update()
              })}
            />
            <button type="submit">{t('input.add')}</button>
          </form>
          {invalid && (
            <p id="empty-error" class="error" role="alert">
              {t('input.invalid')}
            </p>
          )}
          <div class="examples">
            <span>{t('empty.examples')}</span>
            {EXAMPLES.map((example) => (
              <button key={example.key} type="button" mix={on('click', () => store.addMany(example.sources))}>
                {t(example.key)}
              </button>
            ))}
            <button type="button" mix={on('click', () => store.openLibrary('search'))}>
              {t('empty.find')}
            </button>
          </div>
          <span class="platforms">{t('empty.platforms')}</span>
          <p class="fine">{t('empty.private')}</p>
        </div>
      </div>
    </section>
  )
}
