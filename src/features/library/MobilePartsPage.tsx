import {useState,type ComponentProps} from 'react'
import {SeasonBrowser} from '../collections/SeasonBrowser'
import {MobilePartsContent} from './MobilePartsContent'
export function MobilePartsPage(props: ComponentProps<typeof MobilePartsContent>) {
  const [seasonOpen,setSeasonOpen] = useState(false)
  return <><MobilePartsContent {...props} onOpenSeason={()=>setSeasonOpen(true)}/>{seasonOpen && props.detail.season && <SeasonBrowser summary={props.detail.season} onClose={()=>setSeasonOpen(false)}/>}</>
}
