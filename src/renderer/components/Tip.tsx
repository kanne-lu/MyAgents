/** Lightweight CSS-only tooltip — appears instantly on hover, no JS timers.
 *  `position="top"` (default) shows above; `position="bottom"` shows below. */
export default function Tip({ label, children, position = 'top' }: { label: string; children: React.ReactNode; position?: 'top' | 'bottom' }) {
  const posClass = position === 'bottom'
    ? 'top-full mt-1.5'
    : 'bottom-full mb-1.5';
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)]/90 px-2 py-1 text-[11px] text-[var(--button-primary-text)] opacity-0 transition-opacity group-hover/tip:opacity-100 ${posClass}`}>
        {label}
      </span>
    </span>
  );
}
