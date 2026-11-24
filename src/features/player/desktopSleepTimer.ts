export type SleepState = { deadline: number; duration: number; expired: boolean }
export const noSleep: SleepState = { deadline: 0, duration: 0, expired: false }

export function createDesktopSleepTimer(read: () => SleepState, write: (state: SleepState) => void, expire: () => void, clock = Date.now) {
  let pending: ReturnType<typeof setTimeout> | undefined
  const clear = () => { clearTimeout(pending); pending = undefined }
  const check = (expected = read()) => {
    if (expected !== read() || !expected.deadline || expected.deadline > clock()) return false
    clear()
    expire()
    write({ ...expected, deadline: 0, expired: true })
    return true
  }
  const schedule = (state: SleepState) => {
    clear()
    pending = setTimeout(() => {
      if (state === read() && !check(state)) schedule(state)
    }, Math.max(0, state.deadline - clock()))
  }
  return {
    start(seconds: number) {
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 180 * 60) throw new Error('请选择 1 至 180 分钟')
      const state = { deadline: clock() + seconds * 1000, duration: seconds, expired: false }
      write(state); schedule(state)
    },
    cancel() { clear(); write(noSleep) },
    dismiss() { if (read().expired) write(noSleep) },
    check,
  }
}
