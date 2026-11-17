/** Client pacing only: these are conservative defaults, not Bilibili quota claims. */
export const IMPORT_SEARCH_INTERVAL = 3000
export const IMPORT_DETAIL_INTERVAL = 500

function message(error: unknown) {
  return typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
}
export function validImportBvid(value: unknown): value is string {
  return typeof value === 'string' && /^BV[A-Za-z0-9]{10}$/.test(value)
}
export function isUnavailableImportCandidate(error: unknown) {
  if(error && typeof error==='object' && 'code' in error && error.code==='bili_invalid_candidate')return true
  return /-404|-62002|不存在|已删除|不可见|无权限|无效的\s*BV\s*号/i.test(message(error))
}
export function isImportRateLimit(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'bili_rate_limited') return true
  const text = message(error)
  return /(?:\b(?:HTTP\s*)?(?:412|429)\b|(?:^|[^\d])-(?:352|509|799)(?!\d))/.test(text)
    || /(?:B\s*站|Bilibili).*(?:限制搜索|限制了搜索|搜索受限|请求过于频繁|请求被拦截)/i.test(text)
}

export class ImportRequestPolicy {
  blockedUntil = 0
  searchInterval = IMPORT_SEARCH_INTERVAL
  private lastSearch = 0
  private lastDetail = 0
  constructor(private readonly now = () => Date.now()) {}
  searchWait() { return Math.max(0, this.blockedUntil - this.now(), this.lastSearch + this.searchInterval - this.now()) }
  detailWait() { return Math.max(0, this.blockedUntil - this.now(), this.lastDetail + IMPORT_DETAIL_INTERVAL - this.now()) }
  searched() { this.lastSearch = this.now() }
  detailed() { this.lastDetail = this.now() }
  restricted(attempt = 0) {
    const waits = [120_000, 300_000, 900_000]
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + waits[Math.min(2, Math.max(0, attempt))])
    this.searchInterval = Math.max(this.searchInterval, Math.min(12_000, IMPORT_SEARCH_INTERVAL * 2 ** (attempt + 1)))
    return this.blockedUntil
  }
  restore(until = 0, attempts = 0) {
    this.blockedUntil = Math.max(this.blockedUntil, until)
    if (attempts) this.searchInterval = Math.max(this.searchInterval, Math.min(12_000, IMPORT_SEARCH_INTERVAL * 2 ** attempts))
  }
  reset() { this.blockedUntil = 0; this.searchInterval = IMPORT_SEARCH_INTERVAL; this.lastSearch = 0; this.lastDetail = 0 }
}
