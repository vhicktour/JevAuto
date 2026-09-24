# JevAuto: plan for a macOS agent that uses your Mac and the web

**Your choices:**
- Interface: notch island + cursor character.
- Browser: a dedicated agent Chrome profile.
- Jev: you have a TypeSafe key.

**Reviewed by two adversarial passes, folded in below:**
- Scope: 25 changes.
- Correctness: 1 blocker, 16 major, 11 minor. The blocker was Playwright launching Chrome with `--no-sandbox`.

## 1. Context

`/Users/victor/personal/JevAuto` is empty. The goal is a polished macOS Electron app. You give it a task, and an AI agent does it in your Mac apps and on the web, with animation you can follow.
- **Models:** the latest Claude, OpenAI and Gemini computer-use models.
- **Mac control:** Cua Driver.
- **Fast decisions:** Jev, TypeSafe's System One model, as Jev Ultrafast uses it.
- **References:** browser-use/jev-ultrafast, the OpenAI computer-use guide, trycua/cua, CopilotKit/openmuse, milind-soni/OpenMausBot.

**Done for v1 means:**
1. A task typed into the command bar finishes in a real Mac app or website, checked from app or page state.
2. Every action is shown live: cursor, target outline, narration.
3. Consequential actions wait for your approval.
4. Stop quiets all input dispatch within 300 ms, p95 over 20 trials.
5. It runs on Claude, OpenAI and Gemini.
6. It ships as a signed, notarized arm64 DMG that updates without losing permissions.

## 2. Language: TypeScript for everything we write

No Python and no C++ in the product.
- **Electron is Node plus Chromium.** One language covers main, the agent process, renderers, tests and evals.
- **Every dependency has a first-class TypeScript SDK:**
  - `@anthropic-ai/sdk` 0.128.0
  - `openai` 7.23.0
  - `@google/genai` 2.24.0
  - `@typesafe-ai/sdk` 0.6.0
  - `@trycua/cua-driver` 0.28.2: a Rust core over UniFFI, with an Electron-safe N-API runtime
  - `playwright-core` 1.63.0
- **The native, speed-critical OS layer already exists in Rust (Cua Driver).** C++ would add ABI and signing risk for no gain.
- **Python would add a second runtime to sign and notarize.** Jarvis paid for that: the signing walker, `allow-unsigned-executable-memory`, and uv symlink aliases.
- **Jev Ultrafast is Python,** but its logic is about 26 KB plus a reusable in-page `snapshot.js` (MIT), so we port it.
- **One tiny Swift helper, `JevNative`,** for notch geometry, because Electron's `Display` has no safe-area fields. This was verified on your Mac: `auxiliaryTopLeftArea/RightArea` give a 220×38 pt notch.
- **Pins follow Jarvis's proven set:**
  - Electron 44.4.5, electron-vite 5.0.0, electron-builder 26.15.3, electron-updater 6.8.9
  - React 19.3, Tailwind 4.3, `motion` 13.4, zod 4.6
  - TypeScript 5.9.3, pnpm 11.27.1, oxlint 1.85
  - Evaluate TypeScript 7 and pnpm 12 later

## 3. Architecture

```
Electron main (thin; the macOS permission grants are credited to JevAuto.app)
 ├─ WindowCoordinator: notch island · command bar · per-display overlay · settings · menu-bar item
 ├─ JevNative helper: notch/safe-area geometry per display
 ├─ Permissions: @trycua/cua-driver/electron requestMacOSPermissions() after app.whenReady()
 ├─ Secrets: safeStorage (Keychain); keys go to the agent at fork, never to renderers
 ├─ Event relay: agent → main → renderers (Jarvis pattern), zod-validated, sender-checked
 └─ Supervisor ──utilityProcess.fork(disclaim:false, env:{CUA_DRIVER_RS_TELEMETRY_ENABLED:0})──► Agent process (Node, no electron imports)
      ├─ MacDriver = CuaDriver.createConfiguredWithHostIntegrations(Standard, authHost→approval sheet, activityObserver→audit)
      ├─ BrowserDriver = Playwright (sandboxed agent Chrome) + CDPSession hot path
      ├─ provider adapters: Anthropic · OpenAI · Google
      ├─ Jev client
      └─ run log (append-only JSONL per run)
```

- **Cua runs in-process in the agent process.** Cua's EMBEDDING.md calls the same-process SDK the "Preferred application SDK": "TCC checks execute as the importing application".
  - A child that isn't disclaimed stays in the app's TCC responsibility chain, and `utilityProcess` defaults to `disclaim:false`.
  - Nothing ships except the npm native package: no `cua-driver` binary, socket or daemon.
- **Crash isolation:** a driver or agent crash restarts only the agent, with bounded restarts. The run is marked failed and the UI stays up.
- **`MacDriver` is an interface.** If Spike A shows wrong attribution, fall back to:
  1. `create()` in main, then
  2. `EmbeddedCuaDriverHost` spawned by main plus `connect()`. That daemon later enables "expose your Mac to Claude Code/Codex over MCP".
- **Grant changes:** macOS caches TCC per process. The supervisor restarts the agent and reads permission status *from the fresh agent*, because main's view stays stale.

## 4. Mac control (Cua Driver)

- **Background first (Cua's order):** element (AX) action → pixel action, both in the background. Each result's `effect` and `escalation` fields drive the next step.
  - Foreground delivery (front, act, restore) runs only after your per-action OK and is never automatic.
  - `DriverError.ActionInterrupted{completion: Unknown}` means re-observe; never replay.
- **The window is the screen.** The model sees one target window (a `getWindowState` screenshot plus its AX tree). v1 custom tools:
  - `list_windows`
  - `open_app` (background `launch_app`)
  - `switch_target`
  - `ask_user`
  - `done`

  `invoke_menu` and `ax_action` are added only if Spike A shows gaps.
- **Capability matrix per surface,** because the model action spaces exceed what Cua can do in the background. Unsupported members are withheld, not errored: Claude `configs`, Gemini `excluded_predefined_functions`.
  - Hover and `left_mouse_down/up`: not in background.
  - Modifier clicks: foreground, with your OK.
  - `cursor_position` reports our virtual cursor.
  - Right-click on Chromium/Electron web content turns into a left click. Use AX `AXShowMenu`, or refuse.
  - Keys are process-scoped (`SLEventPostToPid`). Text goes through `type_text` (pixel or AX set-value), and bare keys are refused when the target app has more than one window.
- **Window-follow and resize guard:**
  - After each action, diff `listWindows(pid)`. A new window or sheet of the app becomes the target, announced in text.
  - Bounds are recorded at observation. If the size changed before acting, refuse and re-observe.
- **Excluded from the desktop surface (hard rules):**
  - JevAuto's own process
  - security and permission UI: TCC prompts, SecurityAgent, System Settings privacy panes
  - password managers and Keychain Access
  - **every browser**: web work goes only through the agent Chrome in §5, and the agent Chrome is excluded from Cua actions
  - your excluded-apps list
- **Verification:** `verifyState` where possible. Covered Chromium/Electron windows can return stale pixels, so they are verified through AX.
- **Take-over mode comes after v1.** Three things have to be built first:
  - Hide the overlay during full-display capture. Content protection doesn't work: ScreenCaptureKit ignores it on macOS 15+ (tauri#14200, electron#48258).
  - Detect you moving the mouse.
  - Map coordinates across all three displays.

## 5. Browser use

- **Agent Chrome launch.** `chromium.launchPersistentContext(<userData>/browser-profile, …)`:
  - `channel:'chrome'`, `headless:false`, `viewport:null`
  - **`chromiumSandbox:true`**: Playwright otherwise adds `--no-sandbox`
  - `ignoreDefaultArgs: [array]` removes Playwright's weakening defaults:
    - `--use-mock-keychain`, `--password-store=basic`
    - `--disable-client-side-phishing-detection`, `--disable-component-update`, `--disable-background-networking`
    - `--disable-popup-blocking`, `--unsafely-disable-devtools-self-xss-warnings`
    - the default `--disable-features` list, replaced by a curated one that keeps `HttpsUpgrades`

  Never pass `true`, which also drops `--remote-debugging-pipe`. The anti-throttling flags are already Playwright defaults.

  A separate profile avoids Chrome's default-profile debugging lockdown (M136) and its "Allow remote debugging" prompt (M144).
- **"Sign in to sites":** the same profile and keychain mode, launched without automation. Google and others refuse automated sign-in. Logins, CAPTCHAs and 2FA hand off with `ask_user` ("Your turn → Resume"). While you drive, agent actions are refused, not queued.
- **Agent display:** Chrome opens on a display you pick, defaulting to an external one.
- **One element table, one executor:**
  - The ported `snapshot.js` builds the element table behind Claude's `read_page`/`find` refs, Jev's input and the target outline.
  - It runs in every frame via CDP auto-attach. Cross-origin frames it can't read are treated as sensitive.
  - Port fixes: stable identity instead of positional ids (#132), div/span handlers and icon buttons included (#23), an empty-first-observation guard (#1).
- **Secure fields:** any of these marks a field sensitive:
  - `input[type=password]`
  - `-webkit-text-security`
  - `autocomplete` values `cc-*` or `one-time-code`
  - the AX subrole `AXSecureTextField`
- **Playwright and CDP split:** Playwright handles tabs, pop-ups, dialogs, downloads and frames. The hot path uses `newCDPSession`: `Runtime.evaluate`, `Input.*`, `Page.captureScreenshot`. CDP captures are device pixels, so the Frame records the device pixel ratio.
- **Claude's `browser_toolset_20260801` executor rules:**
  - `find` is natural-language matching, up to 20 results.
  - `read_page` has a 50k-character cap and `filter`/`depth`/`ref`.
  - `browser_state` blocks: the full tab list, exactly one active tab, never on error results, exactly one block for tab tools.
  - `navigate` accepts back, forward and reload, and a scheme-less URL becomes `https://`.
  - The halt text is **"Not executed: an earlier action in this turn failed."**
  - Only the members evals show Claude needs are enabled.
- **OpenAI and Gemini** use pixel actions in viewport coordinates.
- **Navigation validator:** http/https only, URL-parsed, allowlist rechecked after redirects, private and loopback ranges blocked by default.
- **Focus:** Cua reports that standalone Chromium activates its window on trusted CDP pointer input. Spike D measures the frontmost app around each `Input.dispatchMouseEvent`. If it steals focus, your typing is gated while the agent acts.
- **Jev fast path (a TypeScript port of Jev Ultrafast):**
  - One snapshot, then one speculative Jev request (`operation` plus `click/type/select_target`), then code executes.
  - It starts in **shadow mode**: logged next to the frontier model's choice, never acting. It acts only after calibration shows precision of at least 98% on at least 30% of steps **and** a near-zero false-negative rate on consequential actions. It acts only below the risk threshold and escalates on low confidence, BLOCKED or a stall. (Broad reliability upstream: 0/20 on BU Bench.)
  - Text you stated exactly is copied, never regenerated.

## 6. Jev in v1 (two jobs; the rest waits for data)

| Job | Primitive | v1 |
|---|---|---|
| Risk gate on non-read actions | Score (read-only / reversible / external or irreversible) | **On, raise-only.** Jev can escalate but never lower a hard-rule or structural result. Uncertain or failed means "ask you". |
| Browser fast path | Choice fan-out | **Shadow mode**, then acting once calibrated |
| Routing, step check, injection screen, desktop fast path | Choice / Noul | After v1, calibrated on logged runs |

- Pin `jev-1.13.0`.
- Only text goes to Jev: never screenshots, secure, hidden or file fields.
- 401/422/429/529 retry with backoff, and a failure never approves anything. Jev reads text an attacker controls, which is why it is raise-only.

## 7. Providers and models

One provider-neutral action IR and one `Frame`. Adapters only translate.

| | Anthropic | OpenAI | Google |
|---|---|---|---|
| Desktop | `computer_toolset_20260801` (no name or size) + function tools | `{type:"computer"}` + function tools | `computer_use` `environment:"desktop"`, **`enable_prompt_injection_detection:true`** (default is false) + functions |
| Browser | `browser_toolset_20260801` (refs) | `computer` on the viewport + `navigate` | `environment:"browser"` |
| Coordinates | pixels of the sent image | pixels of the sent image | int 0–999 ÷ 1000 × dimension, clamped |
| Batch | `tool_use` blocks run in order, halting at the first failure. Halt text depends on `toolset_name`: computer "Not executed: an earlier computer action in this turn failed.", browser as in §5, custom tools a plain error. | `action` or `actions[]`. The output is only a screenshot, so a partial batch adds an `input_text` item saying what ran. | several calls, same halt rule |
| Safety | automatic injection classifiers; `stop_reason:"refusal"` | `pending_safety_checks` → approval → `acknowledged_safety_checks` | `safety_decision: require_confirmation` → approval → `safety_acknowledgement:true` |
| Narration | `thinking.display:"updates"` (beta `thinking-display-updates-2026-08-18`) on Opus 5.5 and Fable 5.1 only. Every provider also narrates from the IR, because updates thin out at high effort. | reasoning summary + IR | `intent` + IR |
| State | append-only (rules below) | `previous_response_id`; stateless = `store:false` + `include:["reasoning.encrypted_content"]` | `previous_interaction_id`. `tools` and `system_instruction` are re-sent every turn. `interactions.delete` at run end. |
| Models (★ default) | ★`claude-opus-5-5` · `claude-sonnet-5` Fast · `claude-fable-5-1` Max | ★`gpt-6-sol` · `gpt-6-luna` · `gpt-6-astra` | ★`gemini-3.8-flash` · `gemini-3.5-flash` |

**Loop correctness rules**, each covered by a golden or live test:
1. **Execute nothing until the turn is complete.** For Claude that means `message_stop` with `stop_reason:"tool_use"`. A refusal mid-stream discards partial blocks.
2. **Tools and system prompt are fixed at run start.** Every toolset and custom tool is declared once. Changing `tools`/`system`, or re-encoding an earlier image, invalidates preserved thinking on Opus 5.5 and Fable 5.1 (a 400 for new accounts).
   - Later operator notes use mid-conversation `role:"system"` messages.
   - `block_binding.prefix_mismatch_behavior:"drop_block"` (beta `thinking-binding-controls-2026-08-01`) is the safety net.
   - A live test fails on any `input_transformations`.
3. **Screenshots are cleared server-side only:** `clear_tool_uses_20250919` (beta `context-management-2025-06-27`), which the docs say "never invalidates thinking blocks". `keep` is at least the maximum batch size + 1, and `clear_tool_inputs:false`.
4. **Every call gets a result before anything else is appended.** Stop answers pending calls with "Not executed: stopped by user", otherwise the next request fails on all three providers.
5. **After an agent restart, never rebuild the conversation.** Start a new one from a run summary.
6. **Coordinates after a `zoom` stay in the last full screenshot's space.** A target change mid-batch (`switch_target`, window-follow, a new tab) halts the remaining coordinate actions.
7. **Request settings:**
   - Each request carries an explicit beta allowlist. `fine-grained-tool-streaming-2025-05-14` is rejected alongside the browser toolset.
   - No `temperature`/`top_p`/`top_k`.
   - `tool_choice:auto`, because forced tool choice returns 400 on Opus 5.5 and Fable 5.1.
   - Opus 5.5 effort is `high`, because thinking can't be turned off and the default is `medium`.

**Frame:** every observation records its source (window or viewport), the capture size and the size sent, the scale computed from the capture, and the origin in points.
- Cua's display scale can be 1.5, so the scale is computed, not assumed.
- The device pixel ratio is recorded for CDP.
- Mapping: model space → the last full sent image → target space (window-local pixels for Cua, CSS pixels for CDP).
- **One letterboxed canvas size per run.** A click on the padding is refused. `zoom` crops the retained full-resolution capture.
- Image sizes:
  - Claude: ≤2576 px long edge and ≤4784 visual tokens; send about 1280–1568 px wide.
  - OpenAI: `detail:"original"`, within the model's patch limit (30,000 patches maximum).
  - Gemini: about 1440×900.
- Fixtures use your layout: the 2× notched built-in display, and two 1× 1080p displays, one at x = −1920.

## 8. Safety and privacy (deny by default)

- **The gate is the only way into an executor.** In order: hard rules → structural detectors → Jev (raise-only) → provider signals.
- **Structural detectors that force approval:**
  - a form submit
  - non-GET or cross-origin requests seen over CDP
  - Enter, newline in `type`, Gemini `press_enter`, or ⌘Enter into a field
  - `cc-*` or one-time-code fields
  - a URL whose query contains text taken from another app or site (no link-click exemption)
- **Target identity:**
  - A pixel action is resolved to an element *before* gating: AX `AXUIElementCopyElementAtPosition`, or DOM `elementFromPoint`.
  - It is re-resolved and compared right before dispatch, after approval.
  - An approval binds run revision, exact arguments, element identity and an expiry (Jarvis UX-CONTRACT). External sends show the exact payload.
- **"Always allow":**
  - scoped to run × app or origin × action class
  - never for sends, payments or deletes
  - revocable in Settings
- **Clipboard:**
  - ⌘V only when the pasteboard `changeCount` matches the agent's own write
  - never content marked `org.nspasteboard.ConcealedType`
  - your clipboard is saved and restored
- **Never:** type into secure fields; act on an excluded surface (§4); send secret or hidden values to a model.
- **Stop:**
  - Abort through the shared signal. After 250 ms, kill the agent.
  - Release any held button or modifier to the last target.
  - Answer pending calls.
  - Record a dispatched effect before checking cancellation.
  - The island's Stop button needs no keyboard, since the hotkey may not fire while Secure Input is on (UNVERIFIED).
  - Locking the Mac pauses the run.
- **Cua hooks:**
  - `DriverAuthorizationHost` requests go to the approval sheet, never auto-accepted.
  - `DriverActivityObserver` feeds the dispatch audit.
  - Telemetry is off, with an egress test.
- **Renderer boundary (onemynd lessons):**
  - sandboxed, `contextIsolation`
  - deny `will-navigate` and new windows
  - one allowlisted command/subscribe bridge
  - sender-frame check
  - test flags ignored when packaged
- **Stated in Settings and at first run:**
  - Screenshots and UI text go to the chosen provider.
  - Only text goes to TypeSafe, which says it doesn't train on user data.
  - Provider-side state (OpenAI's stored responses, Gemini's `store` with 55 days by default) can be switched to stateless.
- **Data:**
  - Keys in Keychain.
  - One append-only JSONL per run (0600), optionally AES-GCM with a safeStorage key.
  - Screenshots in memory unless you "Save trajectory" (7-day retention).
  - Redacted rotating logs.

## 9. Interface and animation

From the references:
- **openmuse** (Expo/React Native, MIT; no motion, no desktop shell):
  - send and stop in the same spot
  - a follow-up queue
  - a hash-bound "One last look" approval with an expiry
  - plan and timeline views
- **OpenMausBot** (Electron 43, Apache-2.0) hosts Cua as a daemon only so external agent CLIs can use MCP. We take:
  - the control model: your control refuses agent actions; there's a "request help" tool; frames captured while you drive are dropped
  - approvals in the composer, ordered Cancel run · Deny · Always allow… · **Allow once**
  - cheap `steps()` indicators
  - its motion constants: rAF spring f=7, `cubic-bezier(0.22,1,0.36,1)` at 0.18–0.32 s, the island spring 0.55 / 0.78
  - its `scripts/prepare-cua.mjs`
- **Cua's cursor** isn't available in-process, is visible to capture, and has offset and full-screen bugs (#3542, #3801). JevAuto draws its own with Cua's motion constants: 900 pt/s peak, turn radius 80, press 120 ms, dwell 80 ms.

**Design: the agent is a cursor character; the notch is its status island.**
- **Overlay:**
  - One `type:'panel'` window per display, on all Spaces, `setIgnoreMouseEvents(true)` (fully click-through).
  - It never appears in model input, by construction: window and CDP captures exclude it.
  - The executor emits `action.planned` (screen rect plus arrival time) and never waits for animation, except in Cinematic mode.
  - Browser target rects come from the AX web-area frame.
  - Occlusion rule: a covered, minimized or off-Space target is shown in the island as "Working in Notes" plus a thumbnail, never as a cursor over your windows.
- **Cursor:**
  - v1: arc travel, press ripple, target outline, amber needs-you and coral error tints.
  - Phase 4: eyes and blink, squash and stretch, trails, key chips, the done check.
- **Notch island:**
  - A solid ink shape matching the notch, animated in CSS inside one fixed transparent panel, click-through outside the shape (Jarvis hit-test). Native glass can't follow a spring between sizes.
  - v1: a pill with narration, n/N, cost and Stop, plus the amber approval state.
  - Phase 4: the morph from the notch, the expanded plan/timeline, and a picture-in-picture.
  - Displays without a notch get a top pill.
  - If placement over the menu bar is unreliable (electron#8141, #38499), it hangs under the notch.
- **Command bar:**
  - A Liquid Glass capsule (`electron-liquid-glass`). Chips: Provider/model, Surface (Auto / This Mac / Browser, fixed per run), Recent.
  - Hotkey ⌃⌥Space. ⌥Space conflicts with ChatGPT, and a failed registration is shown in Settings.
- **Other surfaces:**
  - A menu-bar item.
  - Settings, the only full window: Keys, Permissions, Browser profile, Safety (excluded apps, budgets, Always-allow rules), Data & diagnostics.
- **Motion:**
  - `motion` 13 for UI, a rAF spring for the cursor.
  - Transform and opacity only, 60 fps.
  - Balanced speed plus Reduce Motion in v1; Instant and Cinematic in Phase 4.
  - Reduce Transparency means ink.
- **Tokens:** DESIGN.md → `tokens.css` (Jarvis pipeline). Palette: ink `#08121A`, pearl `#EAF7FF`, cyan `#8EE7F5` for activity, amber `#D5AF74` for needs-you, coral `#EF8C83` for errors. Sora for identity, system font for body.
- **Failure states,** each named in the island with one recovery action:
  - bad key; rate limit or server error (backoff, and actions never auto-retry); refusal; model missing
  - permission revoked or the monthly Screen Recording re-prompt
  - app quit or hung; Chrome closed
  - budget reached ("extend?")
  - stall: the frame unchanged after 3 actions
  - agent crash

  Every run ends with a summary card.
- **Permissions onboarding:**
  - Ask when you enable Mac control.
  - Deep-link `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` and `?Privacy_ScreenCapture`.
  - Trigger one real capture so JevAuto appears in the Screen Recording list.
  - Re-check from the restarted agent, and offer a full relaunch if needed.
  - If macOS won't raise the prompt, `openMacOSScreenRecordingSettings()`.
  - Info.plist gets `NSAccessibilityUsageDescription` and `NSScreenCaptureUsageDescription`.
- **Diagnostics:** Copy diagnostics, an HTML trajectory export, and a debug overlay drawing the Frame's target.

## 10. Repo layout (single package, Jarvis layout)

```
src/main/        lifecycle, WindowCoordinator, permissions, supervisor, event relay
src/preload/     one command + one subscribe channel (Jarvis pattern)
src/renderer/    command-bar, island, overlay, settings (React)
src/shared/      zod protocol: commands, events, run records, IR (PROTOCOL_VERSION, TaskState, Budget, Evidence)
src/agent/       loop/, ir/, frame/, policy/, providers/, jev/, mac/, browser/, runlog/   (lint: no `electron` imports)
native/          JevNative.swift
scripts/         install-electron, tokens, build-native, prepare-cua, verify-app
evals/           fixture web app, desktop + browser suites, headless runner (tsx), reports
```

## 11. Core loop

```
run(task):                                    # tools + system fixed here for the whole run
  frame = observe(target)
  loop until done | stopped | budget | stall:
    turn = await adapter.complete(history, frame)   # stream narration; actions released only at turn end
    if turn.refusal: surface; stop
    shadow: jev.decide(snapshot) logged beside turn (browser)
    for a in turn.actions (in order):
      if a.coordinates and target changed this batch: haltRest(); break
      el = resolve(a); gate = policy(a, el)  # rules → structural → Jev raise-only → provider signal; may await approval
      if denied: haltRest(refused); break
      if resolve(a) != el: haltRest(stale); break
      emit action.planned ; r = execute(a) ; record(r) ; if r.failed: haltRest(); break
    frame = observe(target) ; verify ; append runlog
    history += adapter.results(turn, frame)  # one result per call, halt text per toolset, safety acks
```
Budgets cover steps, wall time and dollars. There is a default per run, and you're asked before it's extended.

## 12. Phases (each exit is evidence)

- **Phase 0: spikes and a walking skeleton,** each time-boxed.
  - **A. Cua on macOS 27.**
    - Setup: `create()` in a signed utilityProcess, with attribution checked through `check_permissions` `source` and `log stream --predicate 'subsystem == "com.apple.TCC" AND eventMessage BEGINSWITH "AttributionChain"'`.
    - Test on TextEdit, Notes, Calendar and one Electron app: menus, sheets, minimized windows, off-Space windows, **two-window key routing**, a held key released on Stop, and Stop during a 500-character type.
    - Exit: at least 45 of 50 background actions confirmed; the grant is picked up by a fresh agent; latency recorded, including #3928's 1 s wait.
  - **B. Overlay and island.**
    - The overlay is absent from window and CDP captures, and `getDesktopState` behaviour is recorded.
    - Panels hold over full-screen Spaces.
    - The island sits at the notch using JevNative geometry.
  - **C. Providers.**
    - Opus 5.5, gpt-6-sol and gemini-3.8-flash each land clicks on 1×, Retina and odd-aspect letterboxed fixtures.
    - Exercise refusal handling, OpenAI `pending_safety_checks`, Gemini `require_confirmation`, and Gemini's desktop `url` field.
    - Then freeze the IR and the Frame.
  - **D. Browser and Jev.**
    - `chrome://sandbox` shows the sandbox active.
    - A sign-in session survives from the non-automated launch into the automated one (keychain round trip).
    - Focus stealing is measured around CDP clicks.
    - Link routing is checked with two Chrome instances.
    - `snapshot.js` port across frames; Jev against hand labels on 30 steps across 3–5 real sites.
  - **E. Walking skeleton.**
    - `scripts/prepare-cua.mjs` (modelled on OpenMausBot's):
      - stage `libcua_driver_sdk.dylib` and `cua_driver_node_runtime.node` outside ASAR and override the SDK's lib resolver
      - re-sign both with our identity so library validation passes, with no `disable-library-validation`
      - the lockfile pins integrity, and `trycua-cua-driver-darwin-arm64-0.28.2.tgz` is checked against the release's `typescript-sdk-checksums.txt` (`9dbc7987…`)
    - The dev bundle has its own id, is signed with a stable Apple Development identity, and is **launched through LaunchServices** (`open -n -a`). An IDE- or terminal-spawned dev app would get the IDE's or terminal's grants.
    - A notarized DMG does one background click for a clean macOS 27 user, then an update keeps the grants. `electron-liquid-glass` and JevNative are in the signing list.
- **Phase 1a: headless agent (Mac, Claude).** Loop, IR, Frame, gate, Claude adapter, Mac executor, runlog, and a CLI runner with terminal approvals and Ctrl-C stop.
  - Exit: at least 24 of 30 on the desktop suite (10 tasks × 3), checked from app state; Stop p95 ≤ 300 ms; all 20 labeled consequential actions gated.
- **Phase 1b: shell.** Command bar, island pill, cursor v1, overlay with the occlusion rule, onboarding, failure states, diagnostics, debug overlay.
  - Exit: the same suite passes from the packaged app; the outline is within 4 pt at 1× and 2×; each injected fault shows its state.
- **Phase 2: browser on Claude, Jev in shadow mode.**
  - Exit:
    - at least 12 of 15 fixture tasks
    - at least 4 of 5 read-only real sites
    - one mixed web→Calendar task passes 3 of 3
    - a shadow report on precision, coverage and consequential false negatives; the fast path acts only if it passes
- **Phase 3: OpenAI and Gemini adapters.**
  - Exit: both suites on all three providers, with success, steps, time and cost per model.
- **Phase 4: design and motion.**
  - Scope:
    - the notch morph and the expanded island
    - the picture-in-picture
    - the cursor character
    - Instant and Cinematic speed modes
    - steer vs. queue
    - Always-allow and the Edit path
    - glass polish
  - Exit: you review a recorded demo; 60 fps across 20 actions; axe clean.
- **Phase 5: release.**
  - Scope: a security review; `electron-updater` (ZIP plus `latest-mac.yml`); bundle id and Team ID frozen.
  - Exit: install and update on a clean account keep the grants.
- **After v1:**
  - Take-over mode with the edge glow.
  - MCP exposure through the daemon.
  - Jev routing, step check and injection screen; the desktop fast path.
  - GPT-6 Astra's code-execution harness in a sandbox.
  - History.

## 13. Verification

- **Unit (vitest):**
  - property-tested Frame math on your three-display layout, including 1.5× scale, device pixel ratio, zoom and letterbox
  - per-provider golden fixtures: request, parse, results, per-toolset halt text, mixed batches, OpenAI partial-batch note, safety acks
  - the gate: structural detectors, raise-only Jev, element re-resolution
  - snapshot parsing
- **Loop tests:**
  - nothing executes before the turn is complete
  - mid-stream refusal fixtures
  - every call answered after Stop
- **Live contract tests (`LIVE=1`, cents per run):**
  - one turn per provider
  - a 30-turn Claude run with zero `input_transformations`
  - the exact beta-header set per request
- **Desktop suite v1** (`~/JevAutoSandbox`, predicates on files and AX):
  1. TextEdit: exact paragraph, bold, RTF.
  2. Finder: PDFs into "Receipts".
  3. Notes: a checklist.
  4. Calendar: read the first event tomorrow.
  5. Reminders: add one.
  6. System Settings: read the appearance mode.
  7. Preview: page 3's heading.
  8. Calculator.
  9. Stickies.
  10. Mail draft. **Expected: stops at the send approval.**
- **Browser suite v1** (fixtures modelled on jev-ultrafast's `fixture.html`, extended):
  1. Flights, cheapest.
  2. Hotel filters.
  3. Wiki fact.
  4. Form validation.
  5. Native select plus div combobox.
  6. Below the fold.
  7. Cookie banner.
  8. Two-tab compare.
  9. Download to an approved folder.
  10. Login. **Expected: `ask_user`.**
  11. Checkout. **Expected: approval before Pay.**
  12. Hidden injection with an exfiltration URL. **Expected: blocked.**
  13. Cross-origin iframe.
  14. Shadow DOM.
  15. Slow spinner.
- **Stop:** p99 until input dispatch goes quiet, including held-key release.
- **Chrome:** sandbox on; keychain sign-in round trip.
- **End to end:** one Playwright smoke test (Jarvis `scripts/verify-app.mjs` pattern: disposable profile, CDP attach, axe, screenshots, `codesign --verify --deep --strict`, bundle hashes).
- **Later:** a Lume VM test for granting Screen Recording while the app runs.
- **Evals** report success, steps, time and cost per model, and feed Jev calibration.

## 14. Risks

| Risk | Handling |
|---|---|
| Cua's SkyLight private calls on macOS 27 (CI is macOS 26) | Spike A first. Fall back to AX-only plus per-action foreground; report upstream. |
| TCC attribution (utility process; dev launched from an IDE) | Attribution-chain log, a LaunchServices-launched dev bundle, the `MacDriver` fallbacks. |
| Packaging found late | Phase 0E walking skeleton. |
| Preserved-thinking 400s | Fixed tools and system, append-only history, server-side clearing, `drop_block`, live `input_transformations` test. |
| Actions before a refusal or safety check | Execute only complete turns; route provider safety checks through approval. |
| Agent Chrome security | `chromiumSandbox:true`, Playwright's weakening defaults stripped, Spike D assertions. |
| Chrome stealing focus on CDP input | Measured in Spike D; if so, your typing is gated during agent actions. |
| Injection steering the gate | Jev raise-only; structural detectors; element identity re-resolved before dispatch. |
| Jev fast-path reliability | Shadow mode; acts only above measured precision and near-zero consequential false negatives. |
| Provider API drift | IR-isolated adapters plus `LIVE=1` tests. |
| Cost | Budgets, screenshot size policy, prompt caching, cost shown in the island. |

## 15. Reused

- **From Jarvis (`/Users/victor/personal/Jarvis`):**
  - `scripts/install-electron.mjs` (the Electron 44 postinstall fix)
  - `scripts/tokens.mjs` and the DESIGN.md front matter
  - `scripts/build-native.mjs`
  - `src/main/windows.ts`: `WindowCoordinator`, panel options, `setVisibleOnAllWorkspaces(…visibleOnFullScreen, skipTransformProcessType)`, `showInactive`, the hit-test loop, glass `addView`
  - `src/preload/index.ts`
  - `src/shared/contracts.ts` (`PROTOCOL_VERSION`, `MAX_MESSAGE_BYTES`, `TaskState`, `Budget`, `Evidence`)
  - UX-CONTRACT approval binding
  - `scripts/verify-app.mjs`
  - the `electron-builder.yml` structure, without Jarvis's Python and audio entitlements
- **From onemynd lessons:** renderer trust boundary, bounded restart, transparent surfaces, click-through hit-testing, panels over full-screen Spaces, the auto-update contract.
- **From OpenMausBot (Apache-2.0; re-implemented):** `prepare-cua.mjs` staging, the control model, approval order.
- **From jev-ultrafast (MIT):** `snapshot.js`, with its notice in THIRD-PARTY.md.

## Appendix: verified facts (2026-09-24)

| Piece | Facts |
|---|---|
| Anthropic | `computer_toolset_20260801`: 17 members, batch actions, results echo `toolset_name`. `browser_toolset_20260801`: 31 members, 27 on by default. Both GA with no beta header and can share a request. Supported on Fable 5.1 ($10/$50), Opus 5.5 ($4/$20, toolset only), Sonnet 5 ($2/$10), Fable 5, Opus 5, Opus 4.8. Haiku 4.5 is not listed. |
| OpenAI | Responses `{type:"computer"}`, `action` or `actions[]`, `pending_safety_checks` → `acknowledged_safety_checks`, `computer_call_output` screenshot with `detail:"original"`; code-execution harness recommended for GPT-6 Astra. `gpt-6-astra` ($10/$50), `gpt-6-sol` ($2/$10), `gpt-6-luna` ($0.10/$0.50). |
| Google | Interactions API; `computer_use` with `browser` / `mobile` / `desktop`; injection detection is opt-in; 0–999 ints; `intent`; `safety_decision`; `store` defaults to true (55 days). `gemini-3.8-flash` ($0.75/$3.75 until 2026-12-31, then $1.50/$7.50), `gemini-3.5-flash` ($1.50/$9.00). |
| Jev | `POST https://api.typesafe.ai/v1/systemone`; `@typesafe-ai/sdk` 0.6.0 (Node 20+); text only; 64k tokens/request; Choice ≤255 options, Score 2–10 levels; $0.042 per M input tokens; 1,200 RPM; `jev-1.13.0`. |
| Cua Driver | 0.28.2 (2026-09-15), MIT, Rust/UniFFI; `@trycua/cua-driver-darwin-arm64` (`.node` plus a 51.7 MB dylib); SDK macOS 13+; CI on macOS 26; typed methods plus `callTool(name, json, {signal})`; `/electron` permission helpers; telemetry on by default. |
| Jev Ultrafast | Python MVP, MIT, `1231850a0b`; 178 ms median Jev call; Flights in 7.1 s; 0/20 on BU Bench. |
| Your Mac | macOS 27.0 (26A428), arm64, Node 24.21.0, Swift 6.4, Developer ID identity, Chrome 153.0.8010.53. Built-in 2056×1329 pt at 2× (notch x 918–1138); LGs at x = 2056 and x = −1920, both 1920×1080 at 1× and top-aligned with the built-in (y = 0 in Electron's top-left space; Cocoa reports y = 249). |
