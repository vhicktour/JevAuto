import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FixtureServer = { port: number; innerPort: number; hits: string[]; close(): Promise<void> }

/** Two loopback-only servers: 127.0.0.1 hosts the pages, [::1] hosts the cross-site iframe (a different site, so an OOPIF). */
export async function startFixtureServer(): Promise<FixtureServer> {
  const hits: string[] = []
  let innerPort = 0
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(url.pathname)
    const html = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(body)
    }
    if (url.pathname === '/set-cookie') {
      res.writeHead(200, { 'Set-Cookie': 'jev=1; Max-Age=86400; Path=/; SameSite=Lax', 'Content-Type': 'text/html' })
      res.end('<title>cookie set</title>cookie set')
    } else if (url.pathname === '/get-cookie') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`cookie: ${req.headers.cookie ?? ''}`)
    } else if (url.pathname === '/frames') html(`<title>frames</title><button>Outer button</button><iframe src="http://[::1]:${innerPort}/inner" width="400" height="200"></iframe>`)
    else if (url.pathname === '/inner') html('<button>Inner button</button><a href="#x">Inner link</a>')
    else if (url.pathname === '/button') html('<title>button</title><button id="b" style="font-size:24px;margin:80px">Press</button>')
    else if (url.pathname === '/price') html(`<title>order</title><div style="font:18px Helvetica;padding:32px"><h1>Your order</h1><p>3 items</p><p>Order total: $${Number(url.searchParams.get('total') ?? '0').toFixed(2)}</p></div>`)
    else if (url.pathname === '/search') html('<title>search</title><form action="/results" style="font:18px Helvetica;padding:32px"><label>Search <input name="q" autofocus></label> <button>Search</button></form>')
    else if (url.pathname === '/results') {
      const q = (url.searchParams.get('q') ?? '').replace(/[<>&"]/g, '')
      html(`<title>Results for ${q}</title><p style="font:18px Helvetica;padding:32px">3 results for ${q}</p>`)
    } else if (url.pathname === '/form')
      html(`<title>form</title><div style="font:16px Helvetica;padding:24px">
        <label>Name <input id="name"></label><br><br>
        <label>Password <input id="pw" type="password"></label><br><br>
        <label>Card <input id="card" autocomplete="cc-number"></label><br><br>
        <label>Notes <textarea id="notes" rows="3">old text</textarea></label><br><br>
        <button id="save" onclick="document.title='saved '+document.getElementById('name').value">Save</button>
        <a id="more" href="/button" target="_blank">More</a>
        <div style="height:2000px"></div><p id="bottom">Bottom of the page</p></div>`)
    else {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    }
  }
  const outer = createServer(handle)
  const inner = createServer(handle)
  await new Promise<void>((r) => outer.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => inner.listen(0, '::1', () => r()))
  innerPort = (inner.address() as AddressInfo).port
  return {
    port: (outer.address() as AddressInfo).port,
    innerPort,
    hits,
    close: async () => {
      await new Promise((r) => outer.close(() => r(null)))
      await new Promise((r) => inner.close(() => r(null)))
    },
  }
}
