/**
 * Chappe's optical telegraph: a mast, the long regulator and two short
 * indicator arms. The arms carry the signal colour.
 */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      aria-hidden="true"
      className="logo"
    >
      <path d="M12 21.5V11M9 21.5h6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 13.7 19.5 8.3" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 13.7 6 18M19.5 8.3 18 4" stroke="var(--signal)" strokeWidth="2" />
      <circle cx="12" cy="11" r="1.3" fill="currentColor" />
    </svg>
  );
}
