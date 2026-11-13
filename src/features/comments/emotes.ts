export type CommentEmote = { text: string; url?: string }
export type CommentEmotePackage = { id: string; name: string; emotes: CommentEmote[] }
export function parseEmotePackages(data: unknown): CommentEmotePackage[] {
  if (!data || typeof data !== 'object' || !('packages' in data) || !Array.isArray(data.packages)) return []
  return data.packages.slice(0, 100).flatMap((pack, index) => {
    if (!pack || (![1,2].includes(pack.id) && (pack.flags?.unlocked === 0 || pack.flags?.unlocked === false)) || !Array.isArray(pack.emote)) return []
    const emotes = pack.emote.slice(0, 400).flatMap((item: Record<string, unknown>) => {
      if (!item || typeof item !== 'object') return []
      const flags = item.flags as Record<string, unknown> | undefined
      const standard = [1,2].includes(pack.id)
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 80 || (!standard && (flags?.unlocked === 0 || flags?.unlocked === false))) return []
      const url = typeof item.url === 'string' ? item.url.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://') : ''
      return [{ text: item.text, url: url.startsWith('https://') ? url : undefined }]
    })
    return emotes.length ? [{ id: String(pack.id ?? index), name: typeof pack.text === 'string' ? pack.text : '表情', emotes }] : []
  })
}
export function insertCommentEmote(message: string, token: string, start: number, end: number, limit = 1000) {
  const next = message.slice(0, start) + token + message.slice(end)
  return Array.from(next).length <= limit ? { message: next, cursor: start + token.length } : undefined
}
