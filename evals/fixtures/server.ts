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
