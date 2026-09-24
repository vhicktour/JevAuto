# JevAuto Phase 1 (1a headless agent, 1b app shell) Implementation Plan

> Executed inline (superpowers:executing-plans) on branch `phase0`, continuing after Phase 0 and UI v1. Victor asked on 2026-09-24 to "proceed with other phases", so this plan is executed without a separate review round; every deviation is ledgered in `.superpowers/sdd/2026-09-24-jevauto-phase1/progress.md`.

**Goal:** you type a task and JevAuto does it in your Mac apps: a model looks at the target window, picks actions, Cua runs them in the background (the cursor and island show each one), consequential actions wait for your OK, Stop always works.

**Spec:** `docs/superpowers/specs/2026-09-24-jevauto-design.md` §3 (architecture), §4 (Mac control), §7 (providers, loop rules), §8 (safety), §11 (core loop), §12 (Phase 1a/1b exits), §13 (desktop suite).

## Global constraints

- Everything from Phase 0's plan still holds (pins, `node:test`, no `electron` in `src/agent/**`, keys only in `.env.local` or Keychain, never printed).
- **Provider:** OpenAI `gpt-6-sol` first (Spike C: 3/3); Claude is blocked on the workspace id and joins behind the same `Adapter` interface; Gemini in Phase 3.
- **Loop rules (spec §7):** execute nothing before the turn is complete; tools and instructions fixed at run start; every call answered before the next request; a halted batch is reported as text; target changes mid-batch halt the remaining pointer actions.
- **Safety (spec §8), deny by default:** hard exclusions refuse; structural detectors (Return/Enter, newline typed, consequential button labels, secure fields, provider safety checks) need "Allow once"; approvals expire; Stop kills the agent after 250 ms.
- **Budgets per run:** 40 actions, 6 minutes, $1.00 (usage × price), stall after 3 unchanged frames.

## Tasks

1. **IR, keys and the OpenAI adapter**: `src/agent/loop/ir.ts` (`IrAction`, `Turn`, `CustomTool`), `src/agent/loop/keys.ts` (`toCuaKeys`), `src/agent/providers/openai/adapter.ts` (`OpenAIAdapter.turn()`: request shapes, parse of `computer_call` (action or actions[]), `function_call`, message text, refusal, `pending_safety_checks`; results as `computer_call_output` / `function_call_output` + a note). Tests: `tests/loop-ir.test.ts`, `tests/openai-adapter.test.ts` (golden-shaped fixtures, request building).
2. **Observe and execute**: `src/agent/loop/observe.ts` (Cua `get_window_state` → capture PNG + AX elements → letterboxed canvas image + `Frame`), `src/agent/loop/execute.ts` (IR → Cua tools through `VisibleMac`, element under a point, window-follow). Tests: `tests/loop-execute.test.ts` with a driver stand-in.
3. **Gate and budgets**: `src/agent/loop/gate.ts` (`gate(action, context)` → allow | ask | refuse), `src/agent/loop/budget.ts`. Tests: `tests/loop-gate.test.ts` (20 labelled consequential actions all ask; exclusions refuse; secure fields refuse), `tests/loop-budget.test.ts`.
4. **The loop and run log**: `src/agent/loop/run.ts` (`runTask`), `src/agent/loop/runlog.ts` (JSONL, 0600). Tests: `tests/loop-run.test.ts` with a scripted adapter and driver: nothing runs before the turn, halt on failure, every call answered, refusal stops, budget and stall stop, Stop mid-batch.
5. **Terminal runner**: `scripts/agent.ts` (`pnpm agent "task"`): terminal approvals, Ctrl-C stop; a live smoke task.
6. **App shell (1b)**: agent method `agent.run`; approvals round trip (agent asks, the island shows Allow once / Deny, main answers); ⌃⌥Space command bar window; keys loaded from `.env.local` in dev into Keychain (`safeStorage`) and passed to the agent at fork; failure states in the island.
7. **Desktop suite**: `evals/desktop/*` (TextEdit, Finder, Notes, Calculator, Reminders, Stickies, Preview, System Settings appearance, Calendar read, Mail draft stops at send), checked from files/AX; `pnpm eval:desktop --repeat 3`; exit ≥ 24/30.

## Phase 2a: one agent for Mac apps and the web (Victor, 2026-09-24: "i want browser and computer use be one")

The spec's per-run Surface choice (Auto / This Mac / Browser) is replaced by one loop that works in both: web tabs in JevAuto's own Chrome are targets like app windows.

8. **Web driver and routing**: `src/agent/browser/web.ts` (`WebDriver`: lazy agent-Chrome launch with the Phase 0 sandboxed options; tabs as windows with ids from 2^30; Cua-shaped results for `get_window_state` (viewport screenshot in device pixels, `window_bounds` = viewport in screen points, DOM elements as AX-like roles, password inputs as `AXSecureTextField`), `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `bring_to_front`; focus from `document.activeElement`), `src/agent/browser/routing.ts` (`RoutingMac`: web window ids go to the web driver, everything else to Cua; `list_windows` merges tabs and drops the agent Chrome's own windows), `src/agent/browser/urls.ts` (http/https only, scheme-less → https, private/loopback blocked unless allowed). Tests: `tests/web-urls.test.ts`, `tests/web-routing.test.ts`, `tests/web-driver.test.ts` (headless Chrome against the fixture server).
9. **Loop wiring**: `open_url` tool; web targets skip the foreground path (CDP keys work in the background); focus takes the window id; instructions name web pages. Tests in `tests/loop-run.test.ts`. Live: a mixed web → TextEdit task from the app in Watch mode.
