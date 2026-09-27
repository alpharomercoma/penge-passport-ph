/** The mark: a calendar page with one open (green) day, drawn in the page's own colours. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="8 6 78 82" aria-hidden="true">
      <rect className="lm-page" x="12" y="18" width="70" height="66" rx="11" strokeWidth="4" />
      <path className="lm-rule" d="M12 34h70" strokeWidth="4" />
      <rect className="lm-ring" x="29.5" y="10" width="6" height="14" rx="3" />
      <rect className="lm-ring" x="58.5" y="10" width="6" height="14" rx="3" />
      <g className="lm-cell">
        <rect x="22" y="38" width="9" height="8" rx="2.2" />
        <rect x="34.5" y="38" width="9" height="8" rx="2.2" />
        <rect x="47" y="38" width="9" height="8" rx="2.2" />
        <rect x="59.5" y="38" width="9" height="8" rx="2.2" />
        <rect x="22" y="49.5" width="9" height="8" rx="2.2" />
        <rect x="34.5" y="49.5" width="9" height="8" rx="2.2" />
        <rect x="59.5" y="49.5" width="9" height="8" rx="2.2" />
        <rect x="22" y="61" width="9" height="8" rx="2.2" />
        <rect x="34.5" y="61" width="9" height="8" rx="2.2" />
        <rect x="47" y="61" width="9" height="8" rx="2.2" />
        <rect x="59.5" y="61" width="9" height="8" rx="2.2" />
      </g>
      <rect className="lm-open" x="47" y="49.5" width="9" height="8" rx="2.2" />
    </svg>
  );
}
