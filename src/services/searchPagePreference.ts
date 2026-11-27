import { create } from 'zustand'

const storageKey = 'simple-search-page'

export const useSearchPagePreference = create<{ simple: boolean; toggle: () => void }>((set, get) => ({
  simple: typeof localStorage === 'undefined' || localStorage.getItem(storageKey) !== 'false',
  toggle: () => {
    const simple = !get().simple
    localStorage.setItem(storageKey, String(simple))
    set({ simple })
  },
}))
