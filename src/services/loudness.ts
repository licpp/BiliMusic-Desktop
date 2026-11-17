import { create } from 'zustand'

export type LoudnessSettings = { enabled: boolean; revision: number }
const key = 'bilimusic-loudness-v1'
function read(): LoudnessSettings {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    return { enabled: value?.enabled === true, revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0 }
  } catch { return { enabled: false, revision: 0 } }
}
export const useLoudnessSettings = create<LoudnessSettings>(() => read())
export function setLoudnessPreference(enabled: boolean) {
  const revision = Math.max(Date.now(), useLoudnessSettings.getState().revision + 1)
  const value = { enabled, revision }
  localStorage.setItem(key, JSON.stringify(value))
  useLoudnessSettings.setState(value)
}
