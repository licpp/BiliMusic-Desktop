import { flushSync } from 'react-dom'

export function focusSearch(show: () => void, input: { current: HTMLInputElement | null }) {
  // WKWebView opens the IME only while this is still the original tap.
  flushSync(show)
  input.current?.focus({ preventScroll: true })
}
