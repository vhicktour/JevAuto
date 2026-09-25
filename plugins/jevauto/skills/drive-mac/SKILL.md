---
name: drive-mac
description: Operate the user's Mac apps and a web browser through JevAuto, the way a person would - look at a window, click, type, press keys, scroll, drag. Use when a task needs a Mac app's interface (TextEdit, Notes, Mail, Calendar, Reminders, Finder, Preview, System Settings, any third-party app) or a website that has to be clicked through, and no API, CLI or file edit can do it.
---

# Drive the Mac with JevAuto

JevAuto's MCP tools (`mcp__jevauto__*`) let you use the Mac's apps and JevAuto's own browser. You are the brain: JevAuto shows you one window at a time and does exactly what you ask, with a visible cursor the user can watch and stop.

## Before you start

- Prefer files, CLIs and APIs when they can do the job; use JevAuto for work that needs an app's interface or a website's pages.
- If a tool says JevAuto is not taking connections, ask the user to open JevAuto and turn on Settings → Claude Code, then `/mcp` to reconnect.

## How to work

1. `windows` lists what you can work in (window ids, apps, titles; web pages show as the app "Web"). `open_app` and `open_url` open something new and show it to you.
2. `look` (optionally with `window`) returns a screenshot and the labelled controls with their centre points. Every x/y you pass afterwards is in pixels of the latest screenshot.
3. Act with `click`, `type`, `keys`, `scroll`, `drag`, `wait`, or batch several with `do` (one call, one screenshot at the end; a failed step stops the rest). Work fast: batch the obvious steps, look only when you need to see.
4. Check the screenshot after each meaningful step. "Not done" in a result means it did not happen: read why and try another way.
5. When you get past a wall, save what worked with `learn` (app, one-sentence tip). Tips show up in later sessions when that app is looked at, so JevAuto gets faster every time.

Tips:
- Click a control's listed centre point rather than guessing from the image.
- Click a text field before `type` if it is not already focused. `keys` takes one key plus modifiers: `["cmd", "b"]`, `["return"]`, `["shift", "tab"]`.
- Websites go through `open_url` (JevAuto's browser). The user's everyday browsers, password managers, password fields, security prompts and JevAuto itself are off limits; JevAuto refuses them.
- JevAuto may ask the user before steps that send, submit, buy or delete (unless they turned on Full auto); the call waits for their answer.
- If a result says the user pressed Stop, stop and ask the user before doing anything else.
