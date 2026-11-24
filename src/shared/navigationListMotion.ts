let moving = 0
let frame = 0
let waitingForPaint = false
const waiting = new Set<() => void>()

function scheduleUpdates() {
  if (moving || frame || (!waitingForPaint && !waiting.size)) return
  // A request made at the end of an animation may still be before its paint.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = 0
      if (moving) return
      waitingForPaint = false
      const updates = [...waiting]
      waiting.clear()
      for (const update of updates) update()
    })
  })
}

export function holdListUpdates() {
  moving++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--moving === 0) waitingForPaint = true
    scheduleUpdates()
  }
}

export function listUpdatesHeld() {
  return moving > 0 || waitingForPaint
}

export function afterListMotion(update: () => void) {
  waiting.add(update)
  scheduleUpdates()
  return () => { waiting.delete(update) }
}
