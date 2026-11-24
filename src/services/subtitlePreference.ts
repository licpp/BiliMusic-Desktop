import type { SubtitlePreference } from '../domain/subtitleLanguage'

const storageKey = 'lyrics-subtitle-language'
const languageTag = /^[a-z0-9_-]{1,48}$/i

export function readSubtitlePreference(): SubtitlePreference | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (typeof saved?.language === 'string' && languageTag.test(saved.language)
      && typeof saved.languageKey === 'string' && languageTag.test(saved.languageKey) && typeof saved.ai === 'boolean') return saved
  } catch { /* Use the default if the preference is unreadable. */ }
}

export function storeSubtitlePreference({ language, languageKey, ai }: SubtitlePreference) {
  if (!languageTag.test(language) || !languageTag.test(languageKey)) return
  localStorage.setItem(storageKey, JSON.stringify({ language, languageKey, ai }))
  window.dispatchEvent(new Event('bilimusic-subtitle-preference'))
}
