import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function SettingsDisclosure({icon,title,description,children,onToggle}:{icon:ReactNode;title:string;description:ReactNode;children:ReactNode;onToggle?:(open:boolean)=>void}) {
  const [mounted,setMounted]=useState(false)
  return <details className="settings-card settings-disclosure" onToggle={event=>{
    const open=event.currentTarget.open
    if(open)setMounted(true)
    onToggle?.(open)
  }}>
    <summary><span className="settings-icon">{icon}</span><span className="settings-disclosure-heading"><strong>{title}</strong><small>{description}</small></span><ChevronDown className="settings-disclosure-chevron" size={17}/></summary>
    {mounted&&<div className="settings-disclosure-body">{children}</div>}
  </details>
}
