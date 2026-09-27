// Small inline icons; decorative unless given a title.
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const ChevronIcon = () => (
  <svg {...base} className="icon icon-chevron" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const SearchIcon = () => (
  <svg {...base} className="icon" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const BellIcon = ({ title }: { title?: string }) => (
  <svg {...base} className="icon icon-bell" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base} className="icon" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const ExternalIcon = () => (
  <svg {...base} className="icon icon-sm" aria-hidden="true">
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base} width={40} height={40} className="icon icon-check" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="m8 12 3 3 5-6" />
  </svg>
);
