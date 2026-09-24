import type { Ref } from 'react'

export type Tint = 'cyan' | 'amber' | 'coral'

const FILL: Record<Tint, [string, string]> = {
  cyan: ['#F4FBFF', '#8EE7F5'],
  amber: ['#FBEBD0', '#D5AF74'],
  coral: ['#FCE1DD', '#EF8C83'],
}

/**
 * The agent: a rounded pointer with a face. Its tip sits at (3, 2) in the 32×40 box, so a parent that places the box
 * at (x − 3, y − 2) puts the tip exactly on the target. `eyesRef` lets an animation loop turn the eyes towards the
 * direction of travel without re-rendering.
 */
export function CursorGlyph({ tint = 'cyan', size = 32, id, eyesRef }: { tint?: Tint; size?: number; id: string; eyesRef?: Ref<SVGGElement> }) {
  const [light, deep] = FILL[tint]
  return (
    <svg width={size} height={(size * 40) / 32} viewBox="0 0 32 40" aria-hidden="true" className="cursor-glyph">
      <defs>
        <linearGradient id={`${id}-body`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={deep} />
        </linearGradient>
      </defs>
      <path
        d="M3 2.6c0-.9 1-1.4 1.7-.8l21.4 17.5c.8.6.4 1.9-.6 2l-9.1.9 5.3 11.2c.4.8 0 1.7-.8 2l-2.7 1.2c-.8.4-1.7 0-2.1-.8l-5-11.2-6.5 5.8c-.7.6-1.6.1-1.6-.8z"
        fill={`url(#${id}-body)`}
        stroke="#08121A"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <g ref={eyesRef} className="cursor-look">
        <g className="cursor-blink">
          <ellipse cx="9.6" cy="14.6" rx="1.45" ry="2.05" fill="#08121A" />
          <ellipse cx="13.9" cy="16.9" rx="1.45" ry="2.05" fill="#08121A" />
          <circle cx="10.05" cy="13.9" r="0.5" fill="#FFFFFF" />
          <circle cx="14.35" cy="16.2" r="0.5" fill="#FFFFFF" />
        </g>
      </g>
    </svg>
  )
}
