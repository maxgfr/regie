import type { Handle, RemixNode } from 'remix/component'
import { css, on } from 'remix/component'

/**
 * A console key: dark plastic when unlit, glowing in its colour when lit.
 * `tone` picks the lamp: red (program), green (main), amber (state), white (neutral).
 */
export const keyStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  minWidth: '30px',
  height: '28px',
  padding: '0 8px',
  border: '1px solid #000',
  borderRadius: '4px',
  background: 'linear-gradient(#22262a, #1a1d20)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.6)',
  color: 'var(--dim)',
  fontFamily: 'var(--font-label)',
  fontWeight: 600,
  fontSize: '13px',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  transition: 'background 120ms, color 120ms, box-shadow 120ms',
  '&:hover:not(:disabled)': { background: 'linear-gradient(#2a2f34, #212528)', color: 'var(--text)' },
  '&:active:not(:disabled)': { transform: 'translateY(1px)' },
  '&:disabled': { opacity: 0.4, cursor: 'default' },
  '&[aria-pressed="true"][data-tone="red"]': {
    background: 'linear-gradient(#ff5047, #d9261d)',
    color: '#fff',
    boxShadow: '0 0 0 1px #000, 0 1px 10px rgba(255,59,48,0.55), inset 0 1px 0 rgba(255,255,255,0.35)',
  },
  '&[aria-pressed="true"][data-tone="green"]': {
    background: 'linear-gradient(#45e07f, #1fae54)',
    color: '#04150a',
    boxShadow: '0 0 0 1px #000, 0 1px 10px rgba(47,211,107,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
  },
  '&[aria-pressed="true"][data-tone="amber"]': {
    background: 'linear-gradient(#ffc24d, #e59600)',
    color: '#1a1000',
    boxShadow: '0 0 0 1px #000, 0 1px 10px rgba(255,176,32,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
  },
  '&[aria-pressed="true"][data-tone="white"]': {
    background: 'linear-gradient(#f1f3ee, #c9ccc6)',
    color: '#0b0c0d',
    boxShadow: '0 0 0 1px #000, 0 1px 8px rgba(255,255,255,0.25), inset 0 1px 0 rgba(255,255,255,0.6)',
  },
  '&[data-fading="true"]': {
    backgroundImage: 'linear-gradient(90deg, #ff5047 var(--fill, 0%), #22262a var(--fill, 0%))',
  },
})

export function Key(
  handle: Handle<{
    label: RemixNode
    title?: string
    pressed?: boolean
    tone?: 'red' | 'green' | 'amber' | 'white'
    disabled?: boolean
    onPress: (event: MouseEvent) => void
    ariaLabel?: string
  }>,
) {
  return () => {
    const { label, title, pressed, tone = 'white', disabled, onPress, ariaLabel } = handle.props
    return (
      <button
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-pressed={pressed === undefined ? undefined : pressed}
        data-tone={tone}
        disabled={disabled}
        mix={[keyStyle, on('click', (event) => onPress(event))]}
      >
        {label}
      </button>
    )
  }
}

/** A horizontal fader with a console-style cap. */
const faderStyle = css({
  appearance: 'none',
  width: '96px',
  height: '22px',
  background: 'transparent',
  cursor: 'pointer',
  '&::-webkit-slider-runnable-track': {
    height: '4px',
    borderRadius: '2px',
    background: 'linear-gradient(90deg, var(--amber) var(--fill), #000 var(--fill))',
    boxShadow: 'inset 0 0 0 1px #000',
  },
  '&::-moz-range-track': { height: '4px', borderRadius: '2px', background: '#000' },
  '&::-moz-range-progress': { height: '4px', borderRadius: '2px', background: 'var(--amber)' },
  '&::-webkit-slider-thumb': {
    appearance: 'none',
    width: '12px',
    height: '20px',
    marginTop: '-8px',
    borderRadius: '2px',
    border: '1px solid #000',
    background: 'linear-gradient(90deg, #8e949a, #e6e8e3 45%, #e6e8e3 55%, #8e949a)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.7)',
  },
  '&::-moz-range-thumb': {
    width: '12px',
    height: '20px',
    borderRadius: '2px',
    border: '1px solid #000',
    background: '#d4d7d2',
  },
  '&[data-size="small"]': { width: '64px' },
})

export function Fader(
  handle: Handle<{ value: number; label: string; onChange: (value: number) => void; size?: 'small' }>,
) {
  return () => {
    const { value, label, onChange, size } = handle.props
    return (
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={String(Math.round(value * 100))}
        aria-label={label}
        title={`${label}: ${Math.round(value * 100)}%`}
        data-size={size}
        style={{ '--fill': `${Math.round(value * 100)}%` }}
        mix={[faderStyle, on('input', (event) => onChange(Number(event.currentTarget.value) / 100))]}
      />
    )
  }
}

/** A labelled group of the console, with its silkscreen label above it. */
export const groupStyle = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  flex: 'none',
  padding: '0 12px',
  borderLeft: '1px solid var(--line)',
  '&:first-child': { borderLeft: 0, paddingLeft: 0 },
  '& > .silk': {
    fontFamily: 'var(--font-label)',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--dim)',
    whiteSpace: 'nowrap',
  },
  '& > .row': { display: 'flex', alignItems: 'center', gap: '4px' },
})

export const switchStyle = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  cursor: 'pointer',
  '& input': { accentColor: 'var(--amber)', width: '16px', height: '16px', margin: '2px 0 0', flex: 'none' },
  '& strong': { display: 'block', fontWeight: 500 },
  '& small': { display: 'block', color: 'var(--dim)', fontSize: '13px', lineHeight: 1.35 },
})
