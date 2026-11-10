import { AudioLines } from 'lucide-react'

export function PlayingMark() {
  return <span className="playing-mark" aria-hidden="true"><AudioLines size={14} /></span>
}
