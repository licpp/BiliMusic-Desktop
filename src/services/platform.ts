import { isTauri } from '@tauri-apps/api/core'
// OHOS ArkWeb may advertise an Android UA. The dedicated build sets this marker
// before bundling the same frontend used by the other four platforms.
export const isOHOS = isTauri() && import.meta.env?.VITE_BILIMUSIC_PLATFORM === 'ohos'
export const isAndroid = isTauri() && !isOHOS && /Android/i.test(navigator.userAgent)
// iPadOS may use a desktop Safari user agent.
export const isIOS = isTauri() && !isOHOS && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
export const isMobile = isAndroid || isIOS || isOHOS
