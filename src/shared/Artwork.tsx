import { Music2 } from 'lucide-react'
import { useState, type ReactNode, type Ref, type SyntheticEvent } from 'react'
import { artworkThumbnail } from './artworkThumbnail'

export function Artwork({ src, className = '', fallback = <Music2 aria-hidden="true" />, adaptAspect = false, variant, onAspectRatio, imageOverlay, elementRef, onError }: {
  src?: string; className?: string; fallback?: ReactNode; adaptAspect?: boolean; variant?: 'thumbnail' | 'progressive'; onAspectRatio?: (ratio:number) => void; imageOverlay?: ReactNode
  elementRef?: Ref<HTMLSpanElement>; onError?: () => void
}) {
  const normalized = src?.replace(/^(?:http:)?\/\//, 'https://')
  const progressive = variant === 'progressive'
  const thumbnail = variant ? artworkThumbnail(normalized) : undefined
  const [failed, setFailed] = useState<string | undefined>()
  const [failedThumbnail, setFailedThumbnail] = useState<string>()
  const [wideImage, setWideImage] = useState<string>()
  const [loaded, setLoaded] = useState<string>()
  const [previewLoaded, setPreviewLoaded] = useState<string>()
  const availableThumbnail = thumbnail && failedThumbnail !== thumbnail ? thumbnail : undefined
  const mainSrc = variant === 'thumbnail' && availableThumbnail ? availableThumbnail : normalized
  const hasImage = Boolean(mainSrc && failed !== mainSrc)
  const showPreview = progressive && Boolean(availableThumbnail)
  const fullReady = progressive && hasImage && loaded === mainSrc
  const previewReady = showPreview && previewLoaded === availableThumbnail
  const reportRatio = ({ currentTarget }: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = currentTarget
    if (!naturalWidth || !naturalHeight) return
    const ratio = naturalWidth / naturalHeight
    if (adaptAspect) setWideImage(ratio > 1.2 ? normalized : undefined)
    onAspectRatio?.(ratio)
  }
  return <span ref={elementRef} className={`artwork ${className}`} data-artwork-fit={adaptAspect ? 'natural' : undefined}
    data-reveal-on-load={progressive || undefined}
    data-artwork-loaded={fullReady || undefined}
    data-artwork-preview-loaded={previewReady || undefined}
    data-artwork-wide={adaptAspect && (hasImage || previewReady) && wideImage === normalized ? true : undefined}>
    {progressive ? <span className="artwork-placeholder">{fallback}</span> : !hasImage && fallback}
    {showPreview && <img key={availableThumbnail} className="artwork-preview" src={availableThumbnail} alt="" decoding="async" referrerPolicy="no-referrer"
      onLoad={event => {
        setPreviewLoaded(availableThumbnail)
        if (!fullReady) reportRatio(event)
      }} onError={() => setFailedThumbnail(availableThumbnail)}/>}
    {hasImage && <img key={mainSrc} className={progressive ? 'artwork-original' : undefined} src={mainSrc} alt="" loading={progressive ? 'eager' : 'lazy'}
      decoding="async" referrerPolicy="no-referrer" fetchPriority={showPreview ? 'low' : undefined}
      onError={() => {
        if (mainSrc === availableThumbnail) setFailedThumbnail(availableThumbnail)
        else {
          setFailed(mainSrc)
          onError?.()
        }
      }}
      onLoad={adaptAspect || onAspectRatio || progressive ? event => {
        if (progressive) setLoaded(mainSrc)
        reportRatio(event)
      } : undefined}/>}
    {hasImage && imageOverlay}
  </span>
}
