import { startTransition, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { isMobile } from '../services/platform'
import { ListSkeleton } from './ListSkeleton'
import { afterListMotion } from './navigationListMotion'
import { usePageMotion } from './pageMotion'
import { SegmentedTabs, type TabOption } from './SegmentedTabs'

export function SwipeTabPages<T extends string>({ tabs, value, onChange, idPrefix, panelId, label, className, fill, tabActions, renderPanel }: {
  tabs: readonly TabOption<T>[]
  value: T
  onChange: (value: T) => void
  idPrefix: string
  panelId: string
  label: string
  className: string
  fill?: boolean
  tabActions?: ReactNode
  renderPanel: (value: T, active: boolean) => ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const swipedTo = useRef<T | undefined>(undefined)
  const activeIndex = tabs.findIndex(tab => tab.id === value)
  usePageMotion(panel, isMobile ? '' : value, isMobile ? 0 : activeIndex, false)
  useLayoutEffect(() => {
    const node = viewport.current
    const select = (event: Event) => {
      const next = tabs[activeIndex + (event as CustomEvent<number>).detail]
      if (!next) return
      event.preventDefault()
      swipedTo.current = next.id
      flushSync(() => onChange(next.id))
    }
    node?.addEventListener('bilimusic-tab-swipe', select)
    return () => node?.removeEventListener('bilimusic-tab-swipe', select)
  }, [activeIndex, tabs, onChange])

  const choose = (next: T) => {
    swipedTo.current = undefined
    const node = viewport.current
    node?.dispatchEvent(new Event('bilimusic-tab-swipe-interrupt'))
    node?.setAttribute('data-animate-tab-tap', '')
    onChange(next)
  }
  const controls = <SegmentedTabs tabs={tabs} value={value} onChange={choose} idPrefix={idPrefix} panelId={panelId}
    label={label} className={className} />

  if (!isMobile) return <>
    {controls}
    <div id={panelId} ref={panel} role="tabpanel" aria-labelledby={`${idPrefix}-${value}`}>
      <div className="segmented-panel" key={value}>{renderPanel(value, true)}</div>
    </div>
  </>

  return <div ref={viewport} className={fill ? 'swipe-pages swipe-pages-fill' : 'swipe-pages'} data-swipe-tabs
    style={{ '--swipe-index': activeIndex } as CSSProperties}
    data-swipe-previous={activeIndex > 0 || undefined} data-swipe-next={activeIndex < tabs.length - 1 || undefined}>
    {controls}
    {tabActions}
    <div className="swipe-track" data-swipe-track>
      {tabs.map(({ id, label }, index) => {
        const position = index - activeIndex
        const paneId = position ? `${panelId}-${id}` : panelId
        return <section className="swipe-pane" key={id} data-swipe-position={position} inert={position !== 0}
          data-distant={Math.abs(position) > 1 || undefined} aria-hidden={position ? true : undefined}
          style={{ '--pane-index': index } as CSSProperties}>
          <div className="segmented-panel swipe-pane-content" id={paneId} role="tabpanel" aria-labelledby={`${idPrefix}-${id}`}>
            <SwipePaneBody active={position === 0} swipeArrival={swipedTo.current === id} label={label} render={() => renderPanel(id, position === 0)} />
          </div>
        </section>
      })}
    </div>
  </div>
}

function SwipePaneBody({ active, swipeArrival, label, render }: { active: boolean; swipeArrival: boolean; label: string; render: () => ReactNode }) {
  const [enteredBy, setEnteredBy] = useState<'tap' | 'swipe' | undefined>(active ? 'tap' : undefined)
  const direct = active && !swipeArrival
  const ready = enteredBy !== undefined || direct
  useLayoutEffect(() => {
    if (!active || enteredBy) return
    if (direct) {
      setEnteredBy('tap')
      return
    }
    return afterListMotion(() => startTransition(() => setEnteredBy('swipe')))
  }, [active, direct, enteredBy])

  return <div className="swipe-pane-body" data-pane-ready={ready || undefined}>
    {(!ready || enteredBy === 'swipe') && <div className="swipe-pane-placeholder" aria-hidden={ready || undefined}>
      <ListSkeleton label={`正在读取${label}`} immediate />
    </div>}
    {ready && render()}
  </div>
}
