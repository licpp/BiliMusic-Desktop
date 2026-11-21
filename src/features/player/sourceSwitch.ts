const handoffTolerance = .25
const preparationError = () => new Error('新音源暂时无法播放，已保留原音质')

function waitForSource(candidate: HTMLAudioElement, event: string, ready: () => boolean, valid: () => boolean, deadline: number) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      clearInterval(check)
      candidate.removeEventListener(event, update)
      candidate.removeEventListener('error', failed)
      error ? reject(error) : resolve()
    }
    const update = () => {
      if (!valid()) finish(new Error('音质切换已取消'))
      else if (ready()) finish()
    }
    const failed = () => finish(preparationError())
    const timer = setTimeout(failed, Math.max(0, deadline - performance.now()))
    const check = setInterval(update, 50)
    candidate.addEventListener(event, update)
    candidate.addEventListener('error', failed)
    update()
  })
}

export async function alignAudioSource(candidate: HTMLAudioElement, position: () => number, valid: () => boolean, deadline: number) {
  let target = Math.max(0, position())
  while (Math.abs(candidate.currentTime - target) > handoffTolerance) {
    if (!valid()) throw new Error('音质切换已取消')
    if (performance.now() >= deadline || target >= candidate.duration) throw preparationError()
    const requested = target
    candidate.currentTime = requested
    await waitForSource(candidate, 'canplay', () =>
      !candidate.seeking && candidate.readyState >= 3
      && Math.abs(candidate.currentTime - requested) <= handoffTolerance, valid, deadline)
    target = Math.max(0, position())
  }
}

// Keep the active element audible while the candidate buffers.
export async function prepareAudioSource(url: string, position: () => number, valid: () => boolean, rate: number): Promise<HTMLAudioElement> {
  const candidate = new Audio()
  candidate.preload = 'auto'
  candidate.muted = true
  candidate.volume = 0
  candidate.playbackRate = rate
  const deadline = performance.now() + 12000
  try {
    candidate.src = url
    candidate.load()
    await waitForSource(candidate, 'loadedmetadata', () => candidate.readyState >= 1, valid, deadline)
    await alignAudioSource(candidate, position, valid, deadline)
    await waitForSource(candidate, 'canplay', () => !candidate.seeking && candidate.readyState >= 3, valid, deadline)
    return candidate
  } catch (error) {
    candidate.pause()
    candidate.removeAttribute('src')
    candidate.load()
    throw error
  }
}
