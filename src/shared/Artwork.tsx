import { Music2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function Artwork({ src, className = '', fallback = <Music2 aria-hidden="true" />, adaptAspect = false, onAspectRatio, imageOverlay }: {
  src?: string; className?: string; fallback?: ReactNode; adaptAspect?: boolean; onAspectRatio?: (ratio:number) => void; imageOverlay?: ReactNode
}) {
  const normalized = src?.replace(/^(?:http:)?\/\//, 'https://')
  const [failed, setFailed] = useState<string | undefined>()
  const [wideImage, setWideImage] = useState<string>()
  const hasImage = Boolean(normalized && failed !== normalized)
  return <span className={`artwork ${className}`} data-artwork-fit={adaptAspect ? 'natural' : undefined}
    data-artwork-wide={adaptAspect && hasImage && wideImage === normalized ? true : undefined}>
    {hasImage ? <img src={normalized} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(normalized)}
      onLoad={adaptAspect || onAspectRatio ? event => {
        const { naturalWidth, naturalHeight } = event.currentTarget
        if (naturalWidth && naturalHeight) {
          setWideImage(naturalWidth / naturalHeight > 1.2 ? normalized : undefined)
          onAspectRatio?.(naturalWidth / naturalHeight)
        }
      } : undefined}/> : fallback}
    {hasImage && imageOverlay}
  </span>
}
