/** Product mark: a "T" (the deadline) with an orange tick — the T−n idea in one glyph. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false" style={{ flex: 'none' }}>
      <rect width="32" height="32" rx="7" fill="var(--c-ink-3)" />
      <path d="M8 10h16M16 10v13" stroke="#f4f3ef" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      <path d="M21 19h5" stroke="var(--c-orange-solid)" strokeWidth="3.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
