import { createRoot } from 'react-dom/client'
import '../styles/app.css'
import { Harness } from './Harness'
import { Overlay } from './Overlay'
import { Island } from './Island'

const surface = new URLSearchParams(location.search).get('surface') ?? window.jevauto.surface
document.body.classList.add(surface)
const view = surface === 'overlay' ? <Overlay /> : surface === 'island' ? <Island /> : <Harness />
createRoot(document.getElementById('root')!).render(view)
