import { readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'

/** playwright-core 1.63.0's default --disable-features value (read from coreBundle.js). */
export const PLAYWRIGHT_DISABLED_FEATURES =
  'AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'

export const IGNORED_DEFAULT_ARGS = [
  '--use-mock-keychain',
  '--password-store=basic',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-popup-blocking',
  '--unsafely-disable-devtools-self-xss-warnings',
  `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES}`,
] as const

/** Only automation-noise features stay off; security and privacy features stay on. */
export const AGENT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'Translate',
  'OptimizationHints',
] as const

export function agentChromeOptions() {
  return {
    channel: 'chrome',
    headless: false,
    viewport: null,
    chromiumSandbox: true, // Playwright adds --no-sandbox unless this is exactly true
    ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS] as string[],
    args: [`--disable-features=${AGENT_DISABLED_FEATURES.join(',')}`],
    timeout: 15_000,
  } satisfies Parameters<typeof chromium.launchPersistentContext>[1]
}

/** The live process holding Chrome's profile lock, or null. Chrome's SingletonLock links to "<host>-<pid>". */
export async function profileLockOwner(profileDir: string): Promise<number | null> {
  let target: string
  try {
    target = await readlink(join(profileDir, 'SingletonLock'))
  } catch {
    return null
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

export async function launchAgentChrome(profileDir: string): Promise<BrowserContext> {
  const owner = await profileLockOwner(profileDir)
  if (owner !== null) throw new Error(`The agent Chrome profile is in use by another Chrome (pid ${owner}). Quit it and try again.`)
  return chromium.launchPersistentContext(profileDir, agentChromeOptions())
}

/** "Sign in to sites": the same profile, launched by LaunchServices without automation (spec §5). */
export function signInLaunchArgs(profileDir: string, url: string): string[] {
  return ['-n', '-a', 'Google Chrome', '--args', `--user-data-dir=${profileDir}`, '--no-first-run', url]
}
