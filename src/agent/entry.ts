import { createAgent, type ParentPortLike } from './agent'
import { handlers, shutdown } from './handlers'

// Electron gives a utility process `process.parentPort`; the agent never imports electron.
const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (!port) throw new Error('The JevAuto agent must run as an Electron utility process.')
createAgent(port, handlers, { onShutdown: shutdown })
