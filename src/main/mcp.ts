import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DRIVE_TOOLS, parseDriveCall, type DriveResult } from '../shared/drive'

/** MCP versions this server speaks. It answers with the client's version when it knows it, else its own newest. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
/** One JSON-RPC message per line; anything longer is not an MCP message JevAuto expects. */
const MAX_LINE = 1 << 20

export const MCP_INSTRUCTIONS = `JevAuto lets you use this Mac's apps and a web browser the way a person does: you look at one window at a time, then click, type, press keys, scroll and drag in it. JevAuto moves its own cursor so the user can watch.

- Start with windows or look. Every x/y you pass is in pixels of the latest screenshot you got; each action returns a fresh one unless you pass screenshot: false.
- look also lists labelled controls with their centre points; clicking those points is the most precise.
- Be fast: batch obvious steps with do (click, type, keys… then one screenshot) instead of one call per step.
- When you get past a wall (something failed, then another way worked), save what worked with learn; later sessions see those tips when they look at that app.
- For websites use open_url (JevAuto's own browser); the user's everyday browsers are off limits.
- JevAuto refuses some things (password fields, password managers, security prompts, itself, apps the user excluded) and may ask the user before sends, submits or deletes unless they turned on Full auto. Read each result: "Not done" means it did not happen.
- If the user presses Stop in JevAuto, stop and ask them before continuing.`

type Json = Record<string, unknown>
type Deps = {
  version: string
  /** Runs one validated call in JevAuto's loop. */
  call: (call: unknown) => Promise<DriveResult>
  log?: (line: string) => void
}

const TOOLS = Object.entries(DRIVE_TOOLS).map(([name, t]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' }) as Json
  return { name, description: t.description, inputSchema }
})

const reply = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/**
 * The MCP side of one client connection (JSON-RPC 2.0, one message per line): initialize, tools/list, tools/call and
 * ping. Kept free of sockets so it can be tested on its own. `busy` says whether another client owns the session.
 */
export class McpProtocol {
  constructor(
    private readonly d: Deps & { busy?: () => string | undefined },
  ) {}

  /** The reply line for one incoming line, or undefined for a notification. */
  async handle(line: string): Promise<string | undefined> {
    let message: Json
    try {
      message = JSON.parse(line) as Json
    } catch {
      return fail(null, -32700, 'Parse error')
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fail(message?.id, -32600, 'Invalid request')
    const { id, method } = message
    const params = (message.params ?? {}) as Json
    if (id === undefined) return undefined // notifications (initialized, cancelled) need no answer
    if (method === 'initialize') {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jevauto', title: 'JevAuto', version: this.d.version },
        instructions: MCP_INSTRUCTIONS,
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') return reply(id, { tools: TOOLS })
    if (method === 'tools/call') return reply(id, await this.call(params))
    return fail(id, -32601, `Method not found: ${method}`)
  }

  private async call(params: Json) {
    const text = (t: string) => ({ content: [{ type: 'text', text: t }], isError: true })
    const busy = this.d.busy?.()
    if (busy) return text(busy)
    const parsed = parseDriveCall({ ...(params.arguments && typeof params.arguments === 'object' ? params.arguments : {}), tool: params.name })
    if (!parsed.ok) return text(parsed.error)
    try {
      const r = await this.d.call(parsed.call)
      return {
        content: [{ type: 'text', text: r.text }, ...(r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : [])],
        isError: !r.ok,
      }
    } catch (error) {
      return text(`JevAuto could not run ${String(params.name)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Claude Code's way in (spec §12, "after v1: MCP exposure"): a Unix socket, readable only by you, that exists only
 * while you allow it in Settings. Claude Code reaches it through `nc -U` (the JevAuto plugin's bin/jevauto-mcp).
 * Several Claude Code sessions may connect; the first to act owns JevAuto until it disconnects or its session ends.
 */
export class McpServer {
  private server?: Server
  private owner?: Socket
  private readonly sockets = new Set<Socket>()
  private pausedUntil = 0

  constructor(private readonly d: Deps & { socketPath: string; end: () => void }) {}

  get driving() {
    return this.owner !== undefined
  }

  async start(): Promise<void> {
    const dir = dirname(this.d.socketPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    rmSync(this.d.socketPath, { force: true }) // a socket left behind by a crash
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.d.socketPath, () => resolve())
    })
    chmodSync(this.d.socketPath, 0o600)
    this.server = server
  }

  /** Turned off in Settings (or JevAuto quits): the socket goes away and every connected client is dropped. */
  stop() {
    this.server?.close()
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    rmSync(this.d.socketPath, { force: true })
    if (this.owner) this.d.end()
    this.owner = undefined
  }

  /** Stop was pressed: refuse calls for a while so Claude Code asks you before going on. */
  pause(ms: number) {
    this.pausedUntil = Date.now() + ms
  }

  /** JevAuto's session ended (idle, Stop, a restart): the next call from any client may start a new one. */
  ended() {
    this.owner = undefined
  }

  private accept(socket: Socket) {
    this.sockets.add(socket)
    const protocol = new McpProtocol({
      version: this.d.version,
      log: this.d.log,
      busy: () =>
        Date.now() < this.pausedUntil
          ? 'The user pressed Stop in JevAuto. Ask them before you continue.'
          : this.owner && this.owner !== socket
            ? 'Another Claude Code session is driving JevAuto right now. Try again when it has finished.'
            : undefined,
      call: async (call) => {
        this.owner = socket
        return this.d.call(call)
      },
    })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
        this.d.log?.('Claude Code connection closed: a message was too large.')
        socket.destroy()
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) void protocol.handle(line).then((out) => out !== undefined && !socket.destroyed && socket.write(`${out}\n`))
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.sockets.delete(socket)
      if (this.owner !== socket) return
      this.owner = undefined
      this.d.end()
    })
  }
}
