import { useEffect, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Artwork } from '../../shared/Artwork'

export function VideoStartup({ poster, ready = false, message, children }: {
  poster?: string; ready?: boolean; message?: string; children?: ReactNode
}) {
  const [showStatus, setShowStatus] = useState(false)
  const waiting = !ready && Boolean(message)
  useEffect(() => {
    if (!waiting) { setShowStatus(false); return }
    const timer = window.setTimeout(() => setShowStatus(true), 180)
    return () => window.clearTimeout(timer)
  }, [waiting])

  return <div className={`video-startup${ready ? ' video-startup-ready' : ''}`} aria-hidden={ready || undefined}>
    <Artwork src={poster}/>
    {waiting && showStatus && <div className="video-startup-status" role="status">
      <LoaderCircle size={16} className="spin"/><span>{message}</span>{children}
    </div>}
  </div>
}
