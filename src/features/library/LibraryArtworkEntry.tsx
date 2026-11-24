import { useState, type ComponentProps, type CSSProperties } from 'react'
import { Artwork } from '../../shared/Artwork'
import { useSeasonCover } from '../../shared/useSeasonCover'
import { LibraryEntry } from './LibraryEntry'

/** Shared cover sizing for playlists, bookmarked collections and their folders. */
export function LibraryArtworkEntry({ coverUrl, seasonReference, artwork, gallery = false, ...entry }: Omit<ComponentProps<typeof LibraryEntry>, 'cover'> & {
  coverUrl?: string
  seasonReference?: string
  artwork?: Omit<ComponentProps<typeof Artwork>, 'src' | 'onAspectRatio' | 'adaptAspect'>
  gallery?: boolean
}) {
  const { ref, cover } = useSeasonCover(seasonReference, coverUrl)
  const [aspect, setAspect] = useState<{ url?: string; ratio: number }>({ ratio: 1 })
  const asGallery = gallery && !entry.sidebar
  const ratio = aspect.url === cover ? aspect.ratio : 1
  const style = asGallery ? {
    ...entry.style, '--library-cover-ratio': Math.max(.75, Math.min(2.4, ratio)),
  } as CSSProperties : entry.style
  return <LibraryEntry {...entry} style={style}
    className={[entry.className, asGallery ? 'library-gallery-item' : ''].filter(Boolean).join(' ')}
    cover={<Artwork {...artwork} elementRef={ref ?? artwork?.elementRef} src={cover} adaptAspect
      onAspectRatio={asGallery ? ratio => setAspect({ url: cover, ratio }) : undefined}/>}/>
}
