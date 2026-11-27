import { invoke } from '@tauri-apps/api/core'

export type HotSearchSource = 'bilibili' | 'netease' | 'qq'
export type HotSearchBadge = 'hot' | 'new' | 'viral' | 'rising'
type HotSearchItem = { keyword: string; title?: string; badge?: HotSearchBadge }
export type HotSearchChart = { items: HotSearchItem[]; stale: boolean }

const freshFor = 30 * 60_000

export function hotSearchQuery(source: HotSearchSource) {
  return {
    queryKey: ['hot-search', source] as const,
    queryFn: () => invoke<HotSearchChart>('hot_search_chart', { source }),
    staleTime: (query: { state: { data?: HotSearchChart } }) => query.state.data?.stale ? 60_000 : freshFor,
    gcTime: 2 * freshFor,
    retry: false,
    refetchOnWindowFocus: false,
  }
}
