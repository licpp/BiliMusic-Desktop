import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function SettingsDisclosure({icon,title,description,children,onToggle,reveal=0}:{icon:ReactNode;title:ReactNode;description:ReactNode;children:ReactNode;reveal?:number;onToggle?:(open:boolean)=>void}) {
  const [mounted,setMounted]=useState(false)
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!reveal || !ref.current) return
    setMounted(true)
    ref.current.open = true
    ref.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [reveal])
  return <details ref={ref} className="settings-card settings-disclosure" onToggle={event=>{
    const open=event.currentTarget.open
    if(open)setMounted(true)
    onToggle?.(open)
  }}>
    <summary><span className="settings-icon">{icon}</span><span className="settings-disclosure-heading"><strong>{title}</strong><small>{description}</small></span><ChevronDown className="settings-disclosure-chevron" size={17}/></summary>
    {mounted&&<div className="settings-disclosure-body">{children}</div>}
  </details>
}
