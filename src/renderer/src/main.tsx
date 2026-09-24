import { createRoot } from 'react-dom/client'
import '../styles/app.css'
import { Harness } from './Harness'

const surface = new URLSearchParams(location.search).get('surface') ?? window.jevauto.surface
document.body.classList.add(surface)
createRoot(document.getElementById('root')!).render(surface === 'harness' ? <Harness /> : null)
