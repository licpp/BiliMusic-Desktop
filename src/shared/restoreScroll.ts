/** Restore after the destination commits; retry if its content is still expanding. */
export function restoreScroll(host: HTMLElement, top: number) {
  let stopped = false, frame = 0
  const stop = () => {
    stopped = true; cancelAnimationFrame(frame); observer.disconnect(); clearTimeout(timeout)
    for (const name of ['pointerdown','touchstart','wheel','keydown']) host.removeEventListener(name, stop)
  }
  const apply = () => { if (!stopped) host.scrollTop = top }
  const observer = new ResizeObserver(apply)
  observer.observe(host)
  for (const child of host.children) observer.observe(child)
  for (const name of ['pointerdown','touchstart','wheel','keydown']) host.addEventListener(name, stop, {passive:true})
  const timeout = setTimeout(stop, 2000)
  apply()
  // A second frame also follows row-location effects in child components.
  frame = requestAnimationFrame(() => { apply(); frame = requestAnimationFrame(apply) })
  return stop
}
