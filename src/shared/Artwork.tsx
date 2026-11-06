import { Music2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function Artwork({ src, className = '', fallback = <Music2 aria-hidden="true" /> }: { src?: string; className?: string; fallback?: ReactNode }) {
  const normalized = src?.replace(/^(?:http:)?\/\//, 'https://')
  const [failed, setFailed] = useState<string | undefined>()
  return <span className={`artwork ${className}`}>{normalized && failed !== normalized ? <img src={normalized} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(normalized)} /> : fallback}</span>
}
