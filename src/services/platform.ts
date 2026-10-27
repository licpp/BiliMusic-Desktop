import { isTauri } from '@tauri-apps/api/core'
export const isAndroid = isTauri() && /Android/i.test(navigator.userAgent)
