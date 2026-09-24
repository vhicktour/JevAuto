import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { CANVAS, planLetterbox, canvasToCapture, normalized1000ToCanvas, type Size, type Rect, type Point, type Letterbox } from '../../src/agent/frame/frame'
import { parseAnthropic } from '../../src/agent/providers/anthropic/parse'
import { parseOpenAI } from '../../src/agent/providers/openai/parse'
import { parseGoogle } from '../../src/agent/providers/google/parse'
import type { IrAction, ParsedTurn, SafetySignal } from '../../src/agent/providers/ir'
import { PHASE0_MODELS } from '../../src/shared/constants'
import { createReport, writeReport, scrub } from '../../src/shared/report'

const INSTRUCTION = 'This image is the whole screen. Click the "Continue" button. Make exactly one click and take no other action.'
const MAX_TURNS = 3
const root = resolve(import.meta.dirname, '../..')
const goldens = join(root, 'tests/fixtures/providers')

type Fixture = { name: string; png: Buffer; size: Size; target: Rect }
type Click = Extract<IrAction, { kind: 'click' }>
type End = { ended: string; click?: Click }
type Outcome = End & { turns: number; refusal: boolean; safety: SafetySignal[]; raw: unknown[] }

/** Why a turn ends the spike's loop, or null to answer its calls and ask for another turn. */
function verdict(turn: ParsedTurn, n: number): End | null {
  if (turn.refusal) return { ended: 'refusal' }
  const click = turn.actions.find((a): a is Click => a.kind === 'click')
  if (click) return { ended: 'click', click }
  if (turn.safety.length) return { ended: 'safety' } // the product asks you first; the spike has nobody to ask
  if (!turn.actions.length) return { ended: 'no-action' }
  return n === MAX_TURNS ? { ended: 'turn-limit' } : null
}

const inside = (p: Point, r: Rect, slack: number) =>
  p.x >= r.x - slack && p.x <= r.x + r.width + slack && p.y >= r.y - slack && p.y <= r.y + r.height + slack

async function makeFixtures(): Promise<Fixture[]> {
  const html = await readFile(join(root, 'evals/fixtures/target-page.html'), 'utf8')
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  const fixtures: Fixture[] = []
  for (const v of [
    { name: '1x', width: 1280, height: 800, scale: 1 },
    { name: 'retina', width: 1280, height: 800, scale: 2 },
    { name: 'portrait', width: 900, height: 1300, scale: 1 },
  ]) {
    const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale })
    const page = await context.newPage()
    await page.setContent(html)
    const box = (await page.locator('#continue').boundingBox())!
    fixtures.push({
      name: v.name,
      png: await page.screenshot({ type: 'png' }),
      size: { width: v.width * v.scale, height: v.height * v.scale },
      target: { x: box.x * v.scale, y: box.y * v.scale, width: box.width * v.scale, height: box.height * v.scale },
    })
    await context.close()
  }
  await browser.close()
  return fixtures
}

async function letterbox(f: Fixture, canvas: Size): Promise<{ base64: string; lb: Letterbox }> {
  const lb = planLetterbox(f.size, canvas)
  const png = await sharp(f.png)
    .resize(lb.content.width, lb.content.height, { fit: 'fill' })
    .extend({ right: canvas.width - lb.content.width, bottom: canvas.height - lb.content.height, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toBuffer()
  return { base64: png.toString('base64'), lb }
}

async function claude(png: string): Promise<Outcome> {
  // An organisation-level key must name its workspace; SDK 0.128.0 has no option for it, so send the header.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID
  const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {})
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png } }
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: INSTRUCTION }, image] }]
  const raw: unknown[] = []
  for (let n = 1; ; n++) {
    // A non-streaming create returns the whole turn, so nothing runs before the turn ends (spec §7 rule 1).
    const message = await client.messages.create({ model: PHASE0_MODELS.anthropic, max_tokens: 16_000, tools: [{ type: 'computer_toolset_20260801' }], messages })
    raw.push(message)
    const turn = parseAnthropic(message)
    const end = message.stop_reason === 'tool_use' || turn.refusal ? verdict(turn, n) : { ended: `stop_reason ${message.stop_reason}` }
    if (end) return { ...end, turns: n, refusal: turn.refusal, safety: turn.safety, raw }
    messages.push({ role: 'assistant', content: message.content })
    messages.push({
      role: 'user',
      content: turn.actions.map((a) => ({
        type: 'tool_result' as const,
        tool_use_id: a.callId,
        toolset_name: 'computer',
        content: a.kind === 'screenshot' ? [image] : 'OK',
      })),
    })
  }
}

async function openai(png: string): Promise<Outcome> {
  const client = new OpenAI()
  const image = `data:image/png;base64,${png}`
  // The docs send detail "original" (no downscaling) with every screenshot; the SDK's output type lags, so it rides in a variable.
  const screenshot = { type: 'computer_screenshot' as const, image_url: image, detail: 'original' }
  const raw: unknown[] = []
  let response = await client.responses.create({
    model: PHASE0_MODELS.openai,
    tools: [{ type: 'computer' }],
    input: [{ role: 'user', content: [{ type: 'input_text', text: INSTRUCTION }, { type: 'input_image', image_url: image, detail: 'original' }] }],
  })
  for (let n = 1; ; n++) {
    raw.push(response)
    const turn = parseOpenAI(response as unknown as Parameters<typeof parseOpenAI>[0])
    const end = verdict(turn, n)
    if (end) return { ...end, turns: n, refusal: turn.refusal, safety: turn.safety, raw }
    response = await client.responses.create({
      model: PHASE0_MODELS.openai,
      tools: [{ type: 'computer' }],
      previous_response_id: response.id,
      // One output per computer_call; a batch shares its call_id.
      input: [...new Set(turn.actions.map((a) => a.callId))].map((call_id) => ({ type: 'computer_call_output' as const, call_id, output: screenshot })),
    })
  }
}

async function gemini(png: string): Promise<Outcome> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  // Tools are per interaction: every turn re-sends them (spec §7).
  const tools = [{ type: 'computer_use' as const, environment: 'desktop' as const, enable_prompt_injection_detection: true }]
  const raw: unknown[] = []
  const ids: string[] = []
  try {
    let interaction = await ai.interactions.create({
      model: PHASE0_MODELS.google,
      tools,
      input: [{ type: 'text', text: INSTRUCTION }, { type: 'image', data: png, mime_type: 'image/png' }],
    })
    for (let n = 1; ; n++) {
      ids.push(interaction.id)
      raw.push(interaction)
      const turn = parseGoogle(interaction as unknown as Parameters<typeof parseGoogle>[0])
      const end = verdict(turn, n)
      if (end) return { ...end, turns: n, refusal: turn.refusal, safety: turn.safety, raw }
      interaction = await ai.interactions.create({
        model: PHASE0_MODELS.google,
        tools,
        previous_interaction_id: interaction.id,
        input: turn.actions.map((a) => ({
          type: 'function_result' as const,
          call_id: a.callId,
          name: a.kind === 'other' ? a.name : 'take_screenshot',
          // Gemini expects the current URL with each result; a desktop target has none.
          result: [{ type: 'text' as const, text: JSON.stringify({ url: 'about:blank' }) }, { type: 'image' as const, data: png, mime_type: 'image/png' }],
        })),
      })
    }
  } finally {
    // Gemini keeps interactions for 55 days by default: delete every one this spike created.
    await Promise.all(ids.map((id) => ai.interactions.delete(id).catch(() => {})))
  }
}

const fixtures = await makeFixtures()
const report = createReport('c')
const providers = [
  { name: 'anthropic', canvas: CANVAS.anthropic, run: claude },
  { name: 'openai', canvas: CANVAS.openai, run: openai },
  { name: 'google', canvas: CANVAS.google, run: gemini },
] as const
await mkdir(goldens, { recursive: true })
for (const p of providers)
  for (const f of fixtures) {
    const name = `${p.name} clicks Continue on ${f.name}`
    const started = performance.now()
    try {
      const { base64, lb } = await letterbox(f, p.canvas)
      const out = await p.run(base64)
      const canvasPoint = out.click && (out.click.space === 'normalized1000' ? normalized1000ToCanvas(out.click, p.canvas) : { x: out.click.x, y: out.click.y })
      const capture = canvasPoint ? canvasToCapture(canvasPoint, lb, f.size) : null
      await writeFile(join(goldens, `${p.name}-${f.name}.json`), JSON.stringify(scrub(out.raw), null, 2))
      report.add({
        name,
        pass: Boolean(capture && inside(capture, f.target, 4)),
        durationMs: Math.round(performance.now() - started),
        details: { ended: out.ended, turns: out.turns, canvasPoint, capture, target: f.target, refusal: out.refusal, safety: out.safety },
      })
    } catch (error) {
      report.add({ name, pass: false, details: { error: error instanceof Error ? error.message : String(error) } })
    }
  }
console.log(await writeReport(join(root, 'evidence'), report.finish()))
