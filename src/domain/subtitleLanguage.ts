import type { LyricLine } from './lyrics'
import { isLyricCredit } from './lyricText'

export type SubtitleChoice = {
  language: string
  languageKey: string
  label: string
  ai: boolean
}
export type SubtitlePreference = Pick<SubtitleChoice, 'language' | 'languageKey' | 'ai'>

const scriptGroups = [
  { script: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, languages: ['ja'] },
  { script: /\p{Script=Hangul}/gu, languages: ['ko'] },
  { script: /\p{Script=Han}/gu, languages: ['zh', 'yue'] },
  { script: /\p{Script=Latin}/gu, languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'id', 'ms', 'vi', 'nl', 'pl', 'tr', 'sv', 'ro', 'cs', 'hu', 'fi', 'da', 'no', 'tl', 'hr', 'sk', 'sl', 'ca', 'eu', 'gl', 'is', 'sw'] },
  { script: /\p{Script=Cyrillic}/gu, languages: ['ru', 'uk', 'bg', 'be', 'mk', 'sr', 'kk', 'ky', 'mn'] },
  { script: /\p{Script=Arabic}/gu, languages: ['ar', 'fa', 'ur', 'ps'] },
  { script: /\p{Script=Thai}/gu, languages: ['th'] },
  { script: /\p{Script=Devanagari}/gu, languages: ['hi', 'mr', 'ne'] },
  { script: /\p{Script=Greek}/gu, languages: ['el'] },
  { script: /\p{Script=Hebrew}/gu, languages: ['he', 'yi'] },
]

// Infer a writing system from the original lyrics. Latin text alone cannot
// distinguish English from Spanish, for example, so alignment checks the cues.
export function lyricSubtitleLanguages(lines: readonly LyricLine[]) {
  // Credits are usually a small part of the text, but can dominate short songs.
  const text = lines.map(line => line.text.normalize('NFKC')).filter(line => !isLyricCredit(line)).join(' ')
  const counts = scriptGroups.map(({ script }) => text.match(script)?.length ?? 0)
  // Kanji and hanja belong to the Japanese or Korean lyrics when accompanied
  // by that language's phonetic script.
  const phonetic = counts[0] >= counts[1] ? 0 : 1
  if (counts[phonetic] >= 2 && counts[phonetic] * 4 >= counts[2]) {
    counts[phonetic] += counts[2]
    counts[2] = 0
  }
  const largest = Math.max(...counts)
  if (largest < 2) return new Set<string>()
  return new Set(scriptGroups.flatMap(({ languages }, index) => counts[index] === largest ? languages : []))
}

export function displaySubtitleChoice(choices: readonly SubtitleChoice[], preference?: SubtitlePreference, languages?: ReadonlySet<string>) {
  const exact = preference && choices.find(choice => choice.language === preference.language)
  if (exact) return exact
  if (preference?.languageKey) {
    const sameLanguage = choices.filter(choice => choice.languageKey === preference.languageKey)
    const closest = sameLanguage.find(choice => choice.ai === preference.ai) ?? sameLanguage[0]
    if (closest) return closest
  }
  const sameScript = choices.filter(choice => languages?.has(choice.languageKey))
  return sameScript.find(choice => choice.ai) ?? sameScript[0] ?? choices.find(choice => choice.ai) ?? choices[0]
}
