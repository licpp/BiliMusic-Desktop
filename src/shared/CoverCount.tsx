import { Layers } from 'lucide-react'

export function CoverCount({ count, unit = '个分 P', single = false }: { count?: number; unit?: string; single?: boolean }) {
  if (!count || !Number.isSafeInteger(count) || count < (single ? 1 : 2)) return null
  const label = `${count} ${unit}`
  return <span className="cover-count" title={label} aria-label={label}><Layers aria-hidden="true"/><span>{count}</span></span>
}
