export const listPlaceholderDelay = 110
const minimumPlaceholderTime = 180

export function listRevealDelay(startedAt: number | undefined, now: number) {
  if (startedAt === undefined || now - startedAt < listPlaceholderDelay) return 0
  return Math.max(0, startedAt + listPlaceholderDelay + minimumPlaceholderTime - now)
}
