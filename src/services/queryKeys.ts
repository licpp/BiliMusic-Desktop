import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { accountEpoch } from './accountScope'

// Keep the feature name first so prefix invalidation remains explicit and local.
// A runtime account session, rather than a UID, also isolates A -> B -> A.
export const accountKeyAt = (session: number, name: string, ...parts: unknown[]) => [name, { accountSession: session }, ...parts] as const
export const accountQueryKey = (name: string, ...parts: unknown[]) => accountKeyAt(accountEpoch(), name, ...parts)
export function isAccountQuery(key: QueryKey) {
  return typeof key[1] === 'object' && key[1] !== null && 'accountSession' in key[1]
}
export function installAccountQueryScope(client: QueryClient) {
  const changing = () => {
    // Cancel synchronously before removing entries: even query functions without
    // AbortSignal support cannot commit a late result into the new session.
    void client.cancelQueries({ predicate: query => isAccountQuery(query.queryKey) })
    client.removeQueries({ predicate: query => isAccountQuery(query.queryKey) })
  }
  window.addEventListener('bilimusic-account-changing', changing)
  return () => window.removeEventListener('bilimusic-account-changing', changing)
}

export const accountQueryFilter = { predicate: (query: { queryKey: QueryKey }) => isAccountQuery(query.queryKey) }
export async function resetAccountQueries(client: QueryClient) {
  await client.cancelQueries(accountQueryFilter)
  await client.resetQueries(accountQueryFilter)
}
