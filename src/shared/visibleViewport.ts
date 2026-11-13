export function visibleViewport(layoutHeight: number, viewportHeight: number, offsetTop: number, baselineHeight: number, nativeKeyboard: number, editing: boolean) {
  const top = Math.max(0, offsetTop)
  // IME insets use the original window's coordinates on Android/OHOS. If
  // adjustResize already reduced the WebView, subtracting them again is wrong.
  const resizedBy = Math.max(0, baselineHeight - layoutHeight)
  const nativeOverlap = Math.max(0, nativeKeyboard - resizedBy)
  // WKWebView can report innerHeight == visualViewport.height while panning
  // offsetTop above zero. This offset moves the origin; it is not lost height.
  const height = Math.max(0, Math.min(viewportHeight, layoutHeight - nativeOverlap))
  return { top, height, overlap: Math.max(0, layoutHeight - height), keyboardOpen: nativeKeyboard > 80 || (editing && baselineHeight - viewportHeight > 80) }
}
