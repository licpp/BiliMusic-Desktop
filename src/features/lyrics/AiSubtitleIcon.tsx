import { Check, LoaderCircle, Minus } from 'lucide-react'

export function AiSubtitleIcon({active,busy=false,manual=false}:{active:boolean;busy?:boolean;manual?:boolean}) {
  return <span className="ai-subtitle-icon" data-enabled={active} aria-hidden="true"><span>{manual?'字':'AI'}</span><i>{busy?<LoaderCircle className="spin"/>:active?<Check/>:<Minus/>}</i></span>
}
