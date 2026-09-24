import { shell } from 'electron'
import { loadStagedCua } from '../agent/mac/cua'

/** Prompts run in main so macOS names JevAuto in the dialog (OpenMausBot and Cua guidance). */
export async function requestPermissions(paths: { cuaSdkPath: string; cuaLibraryPath: string }) {
  const cua = await loadStagedCua(paths.cuaSdkPath, paths.cuaLibraryPath)
  const status = cua.requestMacOSPermissions()
  if (!status.accessibility)
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  if (!status.screenRecording) await cua.openMacOSScreenRecordingSettings()
  return { accessibility: status.accessibility, screenRecording: status.screenRecording }
}
