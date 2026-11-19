import { useState } from 'react'

const storageKey = 'lyrics-match-update-metadata'

export function useMatchMetadataPreference() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === 'true')
  const update = (next: boolean) => {
    localStorage.setItem(storageKey, String(next))
    setEnabled(next)
  }
  return [enabled, update] as const
}
