import type { IconNode } from 'lucide'
import type { Handle } from 'remix/component'
import { createElement } from 'remix/component'

/** A Lucide icon, drawn inline. Decorative unless a label is given. */
export function Icon(handle: Handle<{ icon: IconNode; size?: number; label?: string }>) {
  return () => {
    const { icon, size = 16, label } = handle.props
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden={label ? undefined : 'true'}
        aria-label={label}
        role={label ? 'img' : undefined}
        focusable="false"
      >
        {icon.map(([tag, attrs], index) => createElement(tag, { ...attrs, key: index }))}
      </svg>
    )
  }
}
