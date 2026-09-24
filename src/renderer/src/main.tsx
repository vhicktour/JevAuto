import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/sora/500.css'
import '@fontsource/sora/600.css'
import '../styles/app.css'
import { Activity } from './Activity'
import { Island } from './Island'
import { Overlay } from './Overlay'
import { ProbeIsland, ProbeOverlay } from './Probe'

const surface = new URLSearchParams(location.search).get('surface') ?? window.jevauto.surface
document.body.classList.add(`surface-${surface}`) // prefixed so it can never collide with component classes
const views: Record<string, () => ReactElement> = {
  overlay: () => <Overlay />,
  island: () => <Island />,
  'probe-overlay': () => <ProbeOverlay />,
  'probe-island': () => <ProbeIsland />,
}
createRoot(document.getElementById('root')!).render((views[surface] ?? (() => <Activity />))())
