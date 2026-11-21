const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])
const editableContent = '[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]'

export function isTextEditor(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const input = target.closest<HTMLInputElement>('input')
  if (input) return textInputTypes.has(input.type)
  return Boolean(target.closest(`textarea,${editableContent}`))
}

export function suppressBrowserContextMenu(event: MouseEvent, mobile: boolean) {
  if (!mobile || !isTextEditor(event.target)) event.preventDefault()
}
