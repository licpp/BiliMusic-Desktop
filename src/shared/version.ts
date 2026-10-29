const versionPattern = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(value: string) {
  const match = value.length <= 128 && versionPattern.exec(value)
  if (!match) throw new Error('版本信息格式异常，请稍后重试')
  const pre = match[4]?.split('.') || []
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('版本信息格式异常，请稍后重试')
  return { core: match.slice(1, 4).map(BigInt), pre }
}

/** SemVer ordering, including numeric preview numbers; build metadata is ignored. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left), b = parseVersion(right)
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    if (a.pre[i] === b.pre[i]) continue
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i])
    if (an && bn) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return a.pre[i] > b.pre[i] ? 1 : -1
  }
  return 0
}
