export const APP_BUNDLE_ID = 'personal.jevauto.desktop'
export const DEV_BUNDLE_ID = 'personal.jevauto.desktop.dev'

export const PINS = {
  electron: '44.4.5',
  cuaDriver: '0.28.2',
  playwrightCore: '1.63.0',
  typesafeSdk: '0.6.0',
  anthropicSdk: '0.128.0',
  openai: '7.23.0',
  googleGenai: '2.24.0',
} as const

export const JEV_MODEL = 'jev-1.13.0'

/** The env var the staged Cua bundle reads for its native library path; prepare-cua patches the resolver to honour it. */
export const CUA_LIBRARY_ENV = 'JEVAUTO_CUA_SDK_LIBRARY'

export const PHASE0_MODELS = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-sol',
  google: 'gemini-3.8-flash',
} as const

/** sha256 of the release asset trycua-cua-driver-darwin-arm64-0.28.2.tgz (release typescript-sdk-checksums.txt). */
export const CUA_NATIVE_TGZ_SHA256 = '9dbc79870dc367acbee20c86dee34794e77883e5d5d4b440260652d9341098cb'

/** sha256 of the files inside that tarball, before we thin or re-sign them. */
export const CUA_NATIVE_SHA256 = {
  'libcua_driver_sdk.dylib': '3ba128cf27783605f498b6e372aeb92a14787563e0ed39543f27d232eeabdbbb',
  'cua_driver_node_runtime.node': '4e16135a878fdf6ba5192904288b368eaf193c707473551d118db36a99f534d1',
} as const
