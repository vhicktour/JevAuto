---
version: alpha
name: JevAuto
description: An agent that works in your Mac apps and on the web, shown as a cursor character and a notch island.
colors:
  ink: '#08121A'
  pearl: '#EAF7FF'
  steel: '#91AAB8'
  cyan: '#8EE7F5'
  amber: '#D5AF74'
  coral: '#EF8C83'
  debug: '#FF00FF'
typography:
  display:
    fontFamily: 'Sora, sans-serif'
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
  mono:
    fontFamily: 'SFMono-Regular, ui-monospace, monospace'
rounded:
  control: '12px'
  panel: '28px'
spacing:
  unit: '4px'
  inset: '24px'
---

# JevAuto design system

Ink is the base, pearl is text, cyan marks agent activity, amber asks for a decision, coral marks an error. `debug` magenta exists only for Phase 0 capture checks. Phase 4 extends this file; `scripts/tokens.mjs` turns the front matter into `src/renderer/styles/tokens.css`.
