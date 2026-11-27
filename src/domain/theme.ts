/**
 * Theme preference is what the user chose; the applied theme is always concrete.
 * `system` only exists on platforms that can resolve the OS colour scheme, so
 * every helper takes that capability as an argument instead of assuming it.
 */
export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

export const THEME_STORAGE_KEY = 'bilimusic-theme'

/** Unknown or missing values keep the historical dark default. */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark'
}

export function resolveTheme(preference: ThemePreference, systemTheme: Theme): Theme {
  return preference === 'system' ? systemTheme : preference
}

/** The toggle walks dark → light → system → dark, skipping `system` where it cannot be resolved. */
export function nextThemePreference(preference: ThemePreference, systemSupported: boolean): ThemePreference {
  if (!systemSupported) return preference === 'dark' ? 'light' : 'dark'
  return preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'
}

export function themePreferenceLabel(preference: ThemePreference): string {
  return preference === 'light' ? '浅色' : preference === 'system' ? '跟随系统' : '深色'
}

/** Labels the action a click performs, matching the icon shown on the toggle. */
export function themeActionLabel(preference: ThemePreference, systemSupported: boolean): string {
  const next = nextThemePreference(preference, systemSupported)
  return next === 'light' ? '切换浅色主题' : next === 'system' ? '跟随系统主题' : '切换深色主题'
}
