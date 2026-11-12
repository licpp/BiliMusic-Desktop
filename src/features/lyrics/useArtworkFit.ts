import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

export function fitArtwork(width: number, height: number, ratio: number, compact: boolean) {
  if (width <= 0 || height <= 0 || !Number.isFinite(ratio) || ratio <= 0) return undefined
  const fittedWidth = compact
    ? Math.min(width, height * ratio)
    : Math.min(width * .88, 480, Math.min(height * .86, 320) * ratio)
  return { width: fittedWidth, height: fittedWidth / ratio }
}

// Reserve one media stage for both modes, but fit the cover's actual frame to its image.
export function useArtworkFit(src: string | undefined, enabled: boolean, compact: boolean) {
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({width:0,height:0})
  const [image, setImage] = useState({src,ratio:1})
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const update = () => {
      const width = element.clientWidth, height = element.clientHeight
      setSize(previous => Math.abs(previous.width-width)<.5&&Math.abs(previous.height-height)<.5 ? previous : {width,height})
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, src])
  const ratio = image.src === src ? image.ratio : 1
  const fit = enabled ? fitArtwork(size.width,size.height,ratio,compact) : undefined
  const onRatio = useCallback((ratio:number) => setImage({src,ratio}),[src])
  return {stage,onRatio,style:fit ? {...fit,flexShrink:0} as CSSProperties : undefined}
}
