export function formatPlayCount(value: number) {
  const count = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  if (count >= 100_000_000) return `${Number((count / 100_000_000).toFixed(1))}亿`
  if (count >= 10_000) return `${Number((count / 10_000).toFixed(1))}万`
  return count.toLocaleString('zh-CN')
}
