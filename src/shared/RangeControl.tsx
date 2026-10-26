import type { CSSProperties, InputHTMLAttributes } from 'react'

export function RangeControl(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const min = Number(props.min || 0), max = Number(props.max || 100)
  const fill = Math.max(0, Math.min(100, (Number(props.value || 0) - min) / Math.max(1e-6, max - min) * 100))
  return <input {...props} type="range" style={{ ...props.style, '--range-fill': `${fill}%` } as CSSProperties} />
}
