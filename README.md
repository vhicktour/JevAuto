# JevAuto

An agent that uses your Mac apps and the web for you. You type a task; JevAuto looks at the window it is working in, decides the next step with a computer-use model, and clicks, types and scrolls, in the background or in front of you in Watch mode. Steps that send, buy, delete or change something outside the window wait for your OK.

It is one agent for both: Mac apps are driven through [Cua Driver](https://github.com/trycua/cua), and websites open in JevAuto's own Chrome profile, driven over CDP. A single task can read a web page and then write into a Mac app.

**Status:** early and in active development, on macOS 27 (Apple silicon). OpenAI `gpt-6-sol` runs the loop today; Claude and Gemini adapters are next.

## What you see

- **Task box and ⌃⌥Space bar.** Type what to do; Return runs it.
- **Notch island.** It narrates each step and holds Stop and the Allow / Deny buttons.
- **Cursor.** In Watch mode (on by default) each app comes to the front and the cursor acts every step out in real time: clicks, double-clicks, ⇧-click selections, drags, typed text, keycaps for shortcuts.

## Safety

- The gate is the only way to act. Return and new lines, ⌘-Delete and ⌘Q, buttons like Send, Pay or Delete, and the model provider's own safety flags all ask first. Unanswered approvals expire as a no.
- Stop cancels the run and kills the agent process 250 ms later, so queued input stops too.
- Provider keys go to the agent process only, never to a window, a log or the environment.
- Every run writes a JSONL log readable only by you, without screenshots.

## Run it

Needs macOS 27, Node 24, pnpm 11 (via corepack) and Google Chrome.

```sh
pnpm install
pnpm prepare:cua            # stages and signs the pinned Cua SDK
printf 'OPENAI_API_KEY=...\n' > .env.local
pnpm agent "Open example.com and read me the main heading"      # from the terminal
pnpm app:dev                # the signed dev app (grant Accessibility and Screen Recording once)
pnpm test                   # unit, loop and headless-Chrome tests
pnpm eval:desktop --repeat 3   # the desktop and web task suite, checked from app and page state
```

## Layout

- `src/agent/loop`: the loop, the gate, budgets, observation, the action planner.
- `src/agent/providers`: the model adapters behind one action IR.
- `src/agent/mac`, `src/agent/browser`: Cua and the agent Chrome behind one router.
- `src/main`, `src/renderer`: the Electron shell: supervisor, island, cursor overlay, task box.
- `docs/superpowers`: the design spec and the phase plans.

Third-party notices are in `THIRD-PARTY.md`.
