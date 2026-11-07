import { isTauri } from '@tauri-apps/api/core'
export const isAndroid = isTauri() && /Android/i.test(navigator.userAgent)
// iPadOS may use a desktop Safari user agent.
export const isIOS = isTauri() && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
export const isMobile = isAndroid || isIOS
