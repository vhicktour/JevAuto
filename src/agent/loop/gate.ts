import type { ElementInfo } from '../mac/results'
import type { IrAction } from '../providers/ir'
import type { Focus } from '../../shared/native'
import { toCuaKeys } from './keys'

export type Verdict = { decision: 'allow' } | { decision: 'ask'; reason: string } | { decision: 'refuse'; reason: string }
export type GateTarget = { app: string; bundleId?: string; title?: string }
export type GateInput = {
  action: IrAction
  target: GateTarget
  /** For pointer actions, the element under the point; for typing, the focused element when the snapshot has it. */
  element?: ElementInfo
  /** Where keystrokes go, from AX. 'unknown' when the helper could not tell. */
  focus?: Focus | 'unknown'
  /** The provider's own safety signals on this call (OpenAI pending_safety_checks, Gemini require_confirmation). */
  safety?: unknown[]
  /** Your excluded apps: bundle ids or app names. */
  excluded?: string[]
}

const allow: Verdict = { decision: 'allow' }
const ask = (reason: string): Verdict => ({ decision: 'ask', reason })
const refuse = (reason: string): Verdict => ({ decision: 'refuse', reason })

// Spec §4 hard rules. Bundle ids first; app names only when the bundle id is unknown.
const EXCLUDED: { why: string; bundles: string[]; prefixes?: string[]; names: string[] }[] = [
  { why: 'JevAuto does not control itself.', bundles: [], prefixes: ['personal.jevauto.desktop'], names: ['jevauto', 'jevauto dev'] },
  {
    why: 'Other browsers are off limits; use open_url to open websites in JevAuto’s own browser.',
    bundles: ['com.apple.SafariTechnologyPreview', 'org.chromium.Chromium', 'com.vivaldi.Vivaldi', 'com.kagi.kagimacOS', 'app.zen-browser.zen', 'ai.perplexity.comet', 'com.openai.atlas', 'org.torproject.torbrowser', 'com.duckduckgo.macos.browser', 'com.sigmaos.sigmaos.macos', 'ru.yandex.desktop.yandex-browser', 'com.naver.Whale'],
    prefixes: ['com.apple.Safari', 'com.google.Chrome', 'org.mozilla.', 'com.microsoft.edgemac', 'com.brave.Browser', 'com.operasoftware.Opera', 'company.thebrowser.'],
    names: ['safari', 'safari technology preview', 'google chrome', 'google chrome canary', 'chromium', 'firefox', 'firefox developer edition', 'firefox nightly', 'microsoft edge', 'brave browser', 'opera', 'opera gx', 'vivaldi', 'arc', 'dia', 'orion', 'zen', 'comet', 'chatgpt atlas', 'tor browser', 'duckduckgo', 'sigmaos', 'yandex', 'whale'],
  },
  {
    why: 'Password managers are off limits.',
    bundles: ['com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password', 'com.agilebits.onepassword7', 'com.agilebits.onepassword-osx', 'com.bitwarden.desktop', 'com.lastpass.LastPass', 'org.keepassxc.keepassxc', 'in.sinew.Enpass-Desktop'],
    names: ['keychain access', 'passwords', '1password', '1password 7', 'bitwarden', 'lastpass', 'dashlane', 'keepassxc', 'enpass', 'nordpass', 'proton pass'],
  },
  {
    why: 'Security and permission prompts are yours to answer.',
    bundles: ['com.apple.SecurityAgent', 'com.apple.coreservices.uiagent', 'com.apple.UserNotificationCenter', 'com.apple.accessibility.universalAccessAuthWarn', 'com.apple.LocalAuthentication.UIAgent'],
    names: ['securityagent', 'coreservicesuiagent', 'usernotificationcenter', 'universalaccessauthwarn'],
  },
]
const SETTINGS = { bundles: ['com.apple.systempreferences'], names: ['system settings', 'system preferences'] }
const PRIVACY_PANES = /privacy|security|password|users & groups|touch id|login items|profiles|device management/i

/** Why JevAuto must not act in this window, or undefined when it may. */
export function exclusionReason(t: GateTarget, excluded: string[] = []): string | undefined {
  const bundle = t.bundleId
  const name = t.app.trim().toLowerCase()
  for (const group of EXCLUDED) {
    if (bundle && (group.bundles.includes(bundle) || group.prefixes?.some((p) => bundle.startsWith(p)))) return group.why
    if (!bundle && group.names.includes(name)) return group.why
  }
  const settings = bundle ? SETTINGS.bundles.includes(bundle) : SETTINGS.names.includes(name)
  if (settings && t.title && PRIVACY_PANES.test(t.title)) return 'Privacy and security settings are yours to change.'
  const mine = excluded.map((e) => e.trim().toLowerCase())
  if (mine.includes(name) || (bundle && mine.includes(bundle.toLowerCase()))) return `${t.app} is on your excluded apps list.`
  return undefined
}

export const isExcluded = (t: GateTarget, excluded: string[] = []) => exclusionReason(t, excluded) !== undefined

// Button labels that commit something outside the window: sending, paying, deleting, granting, installing (spec §8).
const CONSEQUENTIAL =
  /\b(send|submit|post|publish|tweet|pay|purchase|buy|checkout|check out|place order|order now|subscribe|unsubscribe|donate|transfer|book|reserve|delete|remove|erase|trash|empty|discard|don['’]t save|overwrite|replace|reset|uninstall|install|revoke|deactivate|allow|grant|authori[sz]e|approve|accept|agree|confirm|sign out|log out|shut down|restart)\b/i
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox', 'AXSecureTextField'])
const SECRET = /password|passcode|passwort|contraseña|mot de passe|\bpin\b/i
const SENSITIVE = /card number|credit card|\bcvc\b|\bcvv\b|security code|one[- ]time|verification code|authentication code|two[- ]factor|\b2fa\b/i
const NAVIGATION = new Set(['tab', 'escape', 'up', 'down', 'left', 'right'])
// Apps whose message box sends on Return. Web-based ones (Slack, Discord, Teams) are also caught as web areas.
const CHAT_BUNDLES = new Set([
  'com.apple.MobileSMS',
  'com.apple.iChat',
  'net.whatsapp.WhatsApp',
  'desktop.WhatsApp',
  'ru.keepcoder.Telegram',
  'com.tdesktop.Telegram',
  'com.hnc.Discord',
  'com.tinyspeck.slackmacgap',
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.facebook.archon',
  'org.whispersystems.signal-desktop',
  'com.skype.skype',
  'us.zoom.xos',
])
const CHAT_NAMES = new Set(['messages', 'whatsapp', 'telegram', 'discord', 'slack', 'microsoft teams', 'messenger', 'signal', 'skype', 'zoom'])

/** Return only adds a line in a Mac app's multi-line text (TextEdit, Notes, Pages); chat boxes and web pages can send. */
function newLineIsSafe(target: GateTarget, focus: Focus | 'unknown' | undefined): boolean {
  if (focus === undefined || focus === 'unknown' || !focus.ok || focus.webArea || focus.role !== 'AXTextArea') return false
  return target.bundleId ? !CHAT_BUNDLES.has(target.bundleId) : !CHAT_NAMES.has(target.app.trim().toLowerCase())
}

function controlLabel(e: ElementInfo | undefined): string {
  if (!e || TEXT_ROLES.has(e.role)) return ''
  return (e.label || (typeof e.value === 'string' ? e.value : '') || '').trim()
}

function fieldName(e: ElementInfo | undefined): string {
  return `${e?.label ?? ''} ${e?.role === 'AXSecureTextField' ? 'password' : ''}`
}

/** Hard rules, then structural detectors, then provider signals (spec §8). Deny by default: unknown focus asks. */
export function gate(i: GateInput): Verdict {
  const excluded = exclusionReason(i.target, i.excluded)
  if (excluded) return refuse(excluded)
  const a = i.action
  const focus = i.focus
  const secure = focus !== undefined && focus !== 'unknown' && focus.secure

  if (a.kind === 'type') {
    if (secure || SECRET.test(fieldName(i.element))) return refuse('That is a password field. JevAuto never types passwords; please type it yourself.')
    if (focus === undefined || focus === 'unknown' || !focus.ok) return ask('JevAuto cannot tell which field this text will go into.')
    if (SENSITIVE.test(fieldName(i.element))) return ask(`This field looks like a card or security code (“${i.element?.label}”).`)
    if (/[\r\n]/.test(a.text) && !newLineIsSafe(i.target, focus)) return ask('Typing a new line can submit a form or send a message.')
  }

  if (a.kind === 'keys') {
    const k = toCuaKeys(a.keys)
    if (!('error' in k)) {
      const key = k.tool === 'hotkey' ? k.keys[k.keys.length - 1] : k.key
      const mods = k.tool === 'hotkey' ? k.keys.slice(0, -1) : []
      if (secure && !(NAVIGATION.has(key) && !mods.length)) return refuse('The focus is on a password field. JevAuto never types into one.')
      if (key === 'return' && !(mods.every((m) => m === 'shift') && newLineIsSafe(i.target, focus)))
        return ask('Pressing Return can submit a form or send a message.')
      if (mods.includes('cmd') && key === 'delete') return ask('⌘Delete moves items to the Trash or deletes them.')
      if (mods.includes('cmd') && key === 'q') return ask('This quits an app or logs you out.')
      if (key === 'd' && mods.length === 2 && mods.includes('cmd') && mods.includes('shift')) return ask('⇧⌘D sends the message in Mail.')
    }
  }

  if (a.kind === 'click' || a.kind === 'drag') {
    const label = controlLabel(i.element)
    if (label && CONSEQUENTIAL.test(label)) return ask(`“${label}” may send, buy, delete or change something outside this window.`)
  }

  if (i.safety?.length) return ask(`The model provider flagged this step: ${safetyText(i.safety)}`)
  return allow
}

function safetyText(checks: unknown[]): string {
  return checks
    .map((c) => (c && typeof c === 'object' && 'message' in c && typeof c.message === 'string' ? c.message : 'a safety check'))
    .join('; ')
}
