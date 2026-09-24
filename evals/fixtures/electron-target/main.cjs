const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.whenReady().then(() => {
  // JEVAUTO_FIXTURE_FULLSCREEN=1 opens in native full screen, i.e. on its own Space (Spike A off-Space, Spike B).
  const fullscreen = process.env.JEVAUTO_FIXTURE_FULLSCREEN === '1'
  const win = new BrowserWindow({ width: 900, height: 640, fullscreen, webPreferences: { contextIsolation: true, sandbox: true } })
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
