import { useState } from 'react'
import type { SeasonSection } from '../domain/bilibili'
import { selectedSeasonSection } from '../domain/seasonSections'
import '../styles/components/season-sections.css'

export function useSeasonSection(reference:string, sections:SeasonSection[] | undefined) {
  const [choice,setChoice] = useState<{reference:string;id?:string}>()
  const selected = selectedSeasonSection(sections,choice?.reference === reference ? choice.id : undefined)?.id
  return [selected,(id?:string) => setChoice({reference,id})] as const
}

export function SeasonSections({sections,selected,onChange}:{sections:SeasonSection[] | undefined;selected?:string;onChange:(id?:string)=>void}) {
  if (!sections || sections.length < 2) return null
  const active = selectedSeasonSection(sections,selected)?.id
  return <div className="season-sections" role="group" aria-label="合集分类" onKeyDown={event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll('button')]
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : index + (event.key === 'ArrowLeft' ? -1 : 1)
    if (!buttons[next]) return
    event.preventDefault(); event.stopPropagation(); buttons[next].focus()
  }}>
    {[{id:undefined,title:'全部'},...sections].map(section => <button key={section.id ?? 'all'} type="button" aria-pressed={section.id === active}
      title={section.title} onClick={event => { onChange(section.id); event.currentTarget.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' }) }} onFocus={event => event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}>{section.title}</button>)}
  </div>
}
