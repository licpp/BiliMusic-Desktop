import { useEffect, useState } from 'react'
export function useCompactLayout() {
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width: 960px)').matches)
  useEffect(()=>{const query=window.matchMedia('(max-width: 960px)');const update=()=>setCompact(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[])
  return compact
}
