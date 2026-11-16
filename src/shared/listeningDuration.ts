/** Compact, explicit units keep rankings readable even after years of listening. */
export function listeningDuration(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  if (total < 60) return `${total}秒`
  if (total < 3600) return `${Math.floor(total / 60)}分`
  return `${Math.floor(total / 3600)}时${Math.floor(total % 3600 / 60)}分`
}

/** Summary values may contain negative zero after floating point aggregation. */
export function listeningTimeParts(seconds: number) {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  return { value: Math.floor(value / (value >= 3600 ? 3600 : 60)), unit: value >= 3600 ? '小时' : '分钟', minutes: value >= 3600 ? Math.floor(value % 3600 / 60) : null }
}
