/** Compact, explicit units keep rankings readable even after years of listening. */
export function listeningDuration(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  if (total < 60) return `${total}秒`
  if (total < 3600) return `${Math.floor(total / 60)}分`
  return `${Math.floor(total / 3600)}时${Math.floor(total % 3600 / 60)}分`
}
