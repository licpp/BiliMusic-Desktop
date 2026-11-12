export type PlayerShortcut = 'toggle' | 'next' | 'previous' | 'seekBack' | 'seekForward' | 'volumeUp' | 'volumeDown'
export function playerShortcut(event: Pick<KeyboardEvent,'code'|'key'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'>): PlayerShortcut | undefined {
  if(event.shiftKey)return
  const command = event.metaKey || event.ctrlKey
  if(command && !event.altKey) return ({ArrowLeft:'previous',ArrowRight:'next',ArrowUp:'volumeUp',ArrowDown:'volumeDown'} as const)[event.key as 'ArrowLeft']
  if(event.altKey && !command) return ({ArrowLeft:'seekBack',ArrowRight:'seekForward'} as const)[event.key as 'ArrowLeft']
  if(event.code==='Space'&&!command&&!event.altKey)return 'toggle'
}
