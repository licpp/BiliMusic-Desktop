import { invoke } from '@tauri-apps/api/core'

export type HotSearchBadge = 'hot' | 'new'
type HotSearchItem = { keyword: string; title?: string; badge?: HotSearchBadge }
export type HotSearchChart = { items: HotSearchItem[]; stale: boolean }

const freshFor = 30 * 60_000

export function hotSearchQuery() {
  return {
    queryKey: ['hot-search', 'bilibili'] as const,
    queryFn: () => invoke<HotSearchChart>('hot_search_chart'),
    staleTime: (query: { state: { data?: HotSearchChart } }) => query.state.data?.stale ? 60_000 : freshFor,
    gcTime: 2 * freshFor,
    retry: false,
    refetchOnWindowFocus: false,
  }
}
