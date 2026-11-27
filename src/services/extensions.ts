import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { HotSearchSource } from './hotSearch'

type SearchExtension = {
  id: string
  title: string
  placement: 'search'
} & ({ group: 'recommendation' } | { group: 'hot-search'; source: HotSearchSource })

export const EXTENSIONS = [
  { id: 'daily', title: '每日推荐', placement: 'search', group: 'recommendation' },
  { id: 'feed', title: 'B 站推荐', placement: 'search', group: 'recommendation' },
  { id: 'bili', title: '热搜', placement: 'search', group: 'hot-search', source: 'bilibili' },
  { id: 'qq', title: 'QQ 音乐热搜', placement: 'search', group: 'hot-search', source: 'qq' },
  { id: 'netease', title: '网易云热搜', placement: 'search', group: 'hot-search', source: 'netease' },
] as const satisfies readonly SearchExtension[]

type ExtensionId = (typeof EXTENSIONS)[number]['id']
const storageKey = 'extensions.enabled.v1'
const searchIds: ReadonlySet<string> = new Set(
  EXTENSIONS.filter(extension => extension.placement === 'search').map(extension => extension.id),
)

function readEnabledIds(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(stored) ? Array.from(new Set(stored.filter(id => typeof id === 'string'))) : []
  } catch {
    return []
  }
}

export const useExtensionPreferences = create<{
  enabledIds: string[]
  setEnabled: (id: ExtensionId, enabled: boolean) => void
}>((set, get) => ({
  enabledIds: readEnabledIds(),
  setEnabled(id, enabled) {
    const { enabledIds } = get()
    if (enabledIds.includes(id) === enabled) return
    const next = enabled ? [...enabledIds, id] : enabledIds.filter(value => value !== id)
    localStorage.setItem(storageKey, JSON.stringify(next))
    set({ enabledIds: next })
  },
}))

export function useSearchExtensions() {
  return useExtensionPreferences(useShallow(state => state.enabledIds.filter(id => searchIds.has(id))))
}
