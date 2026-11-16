type ProgressKeyAction = { kind: 'draft'; value: number | null } | { kind: 'seek'; value: number } | { kind: 'leave' }

// Up/down leave an uncommitted preview without seeking. They must then bubble
// to directional navigation; only left/right belong to the range editor.
export function progressKeyAction(key: string, draft: number | null, position: number, duration: number, repeat = false): ProgressKeyAction | undefined {
  if (key === 'Enter' || key === ' ') return draft === null ? { kind: 'draft', value: position } : { kind: 'seek', value: draft }
  if (draft === null) return
  if (key === 'ArrowUp' || key === 'ArrowDown') return { kind: 'leave' }
  if (key === 'Escape' || key === 'BrowserBack') return { kind: 'draft', value: null }
  if (key === 'ArrowLeft' || key === 'ArrowRight') return { kind: 'draft', value: Math.max(0, Math.min(duration, draft + (key === 'ArrowRight' ? 1 : -1) * (repeat ? 15 : 5))) }
}
