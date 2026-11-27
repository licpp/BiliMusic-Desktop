/**
 * "Follow the system" state: a light-theme sun with a dark-theme moon filling
 * the bottom-right corner. Drawn in the lucide stroke grid so it sits next to
 * Sun/Moon without a size or weight jump. The moon is a solid crescent: outer
 * arc clockwise, inner arc back counter-clockwise, both meeting at the horns.
 */
export function ThemeSystemIcon({ size = 24, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
    <circle cx="8.6" cy="8.6" r="3.2" />
    <path d="M8.6 3.8V2M8.6 13.4v1.8M3.8 8.6H2M13.4 8.6h1.8M5.2 5.2 4 4M12 5.2l1.2-1.2M5.2 12 4 13.2" />
    <path fill="currentColor" stroke="none" d="M18.85 12A5.6 5.6 0 1 1 12 18.85A5 5 0 0 0 18.85 12Z" />
  </svg>
}
