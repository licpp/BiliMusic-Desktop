import { Music2 } from 'lucide-react'
import { useState } from 'react'

export function Artwork({ src, className = '' }: { src?: string; className?: string }) {
  const normalized = src?.replace(/^http:\/\//, 'https://')
  const [failed, setFailed] = useState<string | undefined>()
  return <span className={`artwork ${className}`}>{normalized && failed !== normalized ? <img src={normalized} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(normalized)} /> : <Music2 aria-hidden="true" />}</span>
}
