import { songQueries, type SongQuery, type SongQueryInput } from '../domain/songIdentity'

/** Bound ambiguous title lookups to two orientations. Recognition does not
 * choose a result or write metadata; each feature retains that responsibility. */
export async function lookupSongs<T>(
  input: SongQueryInput,
  request: (query: SongQuery) => Promise<{ items: T[]; warning?: string }>,
  identity: (item: T) => string,
  valid: () => boolean,
) {
  const queries = songQueries(input), items = new Map<string, T>(), warnings = new Set<string>()
  let successes = 0, failures = 0, firstError: unknown
  const check = () => { if (!valid()) throw new Error('ACCOUNT_SESSION_EXPIRED') }
  for (const query of queries) {
    check()
    if (!query.title.trim()) continue
    try {
      const result = await request(query)
      check(); successes++
      for (const item of result.items) if (!items.has(identity(item))) items.set(identity(item), item)
      if (result.warning) warnings.add(result.warning)
    } catch (error) {
      check(); failures++; firstError ??= error
    }
  }
  if (failures && !successes) throw firstError
  if (failures) warnings.add('部分查询未完成，可重试获取更多结果')
  return { items: [...items.values()], queries, warning: [...warnings].join('；') || undefined }
}
