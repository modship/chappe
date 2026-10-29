/** A cog, for settings. */
export function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M6 1.2h2l.35 1.6 1.2.7 1.55-.5 1 1.73-1.2 1.1v1.34l1.2 1.1-1 1.73-1.55-.5-1.2.7L8 12.8H6l-.35-1.6-1.2-.7-1.55.5-1-1.73 1.2-1.1V6.83L1.9 5.73l1-1.73 1.55.5 1.2-.7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="7" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}
