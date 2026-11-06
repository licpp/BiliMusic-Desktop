import { useState, type MouseEvent } from 'react'

export type MenuPosition = { left: number; top: number; nonce: number }

export function useRowContextMenu() {
  const [position, setPosition] = useState<MenuPosition>()
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setPosition(previous => ({ left: event.clientX, top: event.clientY, nonce: (previous?.nonce ?? 0) + 1 }))
  }
  return { position, onContextMenu }
}
