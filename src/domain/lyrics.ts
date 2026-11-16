export type LyricWord = { text: string; startTimeMs: number; endTimeMs: number }
export type LyricLine = { words?: LyricWord[]; endTimeMs?: number; timeMs: number; text: string; translation?: string; romanization?: string }
export type LyricCandidate = { provider: 'lrclib' | 'netease' | 'qq' | 'local'; id: number; trackName: string; artistName: string; albumName: string; duration: number; instrumental: boolean; plainLyrics?: string; syncedLyrics?: string; translatedLyrics?: string; romanizedLyrics?: string }
export type LyricSearchResult = { candidates: LyricCandidate[]; warning?: string }
export type StoredLyrics = { trackId: string; provider: string; providerLyricId: string; rawText: string; parsedJson: string; biasMs: number; selectedManually: boolean; writeToken?: string; accountSession?: string }
