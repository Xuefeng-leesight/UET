import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  normalizeFacialRecordingSettings,
  type FacialRecordingSettings,
} from '@/features/recording/domain/recordingModules'

export function useProjectFacialSettings(params: {
  projectDir: string | null
  projectDefaults: unknown
  enabled: boolean
  settings: FacialRecordingSettings
  setSettings: Dispatch<SetStateAction<FacialRecordingSettings>>
  setCameraId: Dispatch<SetStateAction<string>>
}): void {
  const { projectDir, projectDefaults, enabled, settings, setSettings, setCameraId } = params
  const loadedProjectRef = useRef('')

  useEffect(() => {
    if (!projectDir) {
      loadedProjectRef.current = ''
      return
    }
    try {
      const stored = JSON.parse(localStorage.getItem(`facial-analysis-settings:${projectDir}`) || '{}')
      const normalized = normalizeFacialRecordingSettings({
        ...(projectDefaults && typeof projectDefaults === 'object' ? projectDefaults : {}),
        ...stored,
        enabled,
      })
      loadedProjectRef.current = projectDir
      setSettings(normalized)
      if (normalized.cameraId) setCameraId(normalized.cameraId)
    } catch {
      loadedProjectRef.current = projectDir
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectDefaults, projectDir, setCameraId, setSettings])

  // Persist settings only when the settings object itself changes — NOT on
  // projectDir change. On project switch the load effect above queues
  // setSettings(normalized), but within the same commit `settings` still
  // holds the previous project's value; depending on projectDir here would
  // write the previous project's settings into the new project's key (dirty
  // write). Once setSettings applies, this effect re-runs with the matching
  // projectDir + settings pair.
  useEffect(() => {
    if (!projectDir || loadedProjectRef.current !== projectDir) return
    try {
      localStorage.setItem(
        `facial-analysis-settings:${projectDir}`,
        JSON.stringify({ ...settings, captureWithRecording: settings.enabled }),
      )
    } catch {
      // localStorage may be unavailable (private mode / quota); ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])
}
