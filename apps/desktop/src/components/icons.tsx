// Inline SVG icons (Lucide-style, 1.5px stroke). Kept local to avoid a
// dependency; all share one visual language for consistency.

type IconProps = {
  className?: string;
  /** Decorative by default; pass a label to expose the icon to AT. */
  title?: string;
};

function Svg({ className, title, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const CloseIcon = XIcon;

export const ChipIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </Svg>
);

export const LayersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Svg>
);

export const RulerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h18v8H3z" />
    <path d="M7 8v3M11 8v4M15 8v3M19 8v4" />
  </Svg>
);

export const HardDriveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13h18l-2.5-6.5A2 2 0 0 0 16.6 5H7.4a2 2 0 0 0-1.9 1.5L3 13Z" />
    <path d="M3 13v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
    <path d="M7 16h.01" />
  </Svg>
);

export const MemoryIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="8" width="18" height="9" rx="1.5" />
    <path d="M7 8V6M12 8V6M17 8V6M7 17v1M17 17v1" />
  </Svg>
);

export const WarningIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);

export const TagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7v5.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l5.2-5.2a2 2 0 0 0 0-2.8L11.6 6A2 2 0 0 0 10.2 5H4.6A1.6 1.6 0 0 0 3 6.6Z" />
    <path d="M7.5 7.5h.01" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 4v5h-5" />
  </Svg>
);

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </Svg>
);

export const LibraryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4v16" />
    <path d="M8 4v16" />
    <path d="m12.5 4.5 3.6 1 3.4 14.5-3.6-1Z" />
  </Svg>
);

export const WorkflowIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
    <path d="M6.5 10v3a3 3 0 0 0 3 3h4.5" />
  </Svg>
);

/** Star — outline by default, solid when `filled`, for favorites. */
export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9Z"
      fill={filled ? "currentColor" : "none"}
    />
  </Svg>
);

export const GlobeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
  </Svg>
);

export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
    <path d="M13 2v5h5" />
  </Svg>
);

export const BrainIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 4a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 5 9v.5A2.5 2.5 0 0 0 5 14a2.5 2.5 0 0 0 2 4 2.5 2.5 0 0 0 5 0V4.5A2.5 2.5 0 0 0 9.5 4Z" />
    <path d="M14.5 4A2.5 2.5 0 0 1 17 6.5 2.5 2.5 0 0 1 19 9v.5a2.5 2.5 0 0 1 0 4.5 2.5 2.5 0 0 1-2 4" />
  </Svg>
);

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const BoxesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3 8 4-8 4-8-4 8-4Z" />
    <path d="m4 7v6l8 4 8-4V7" />
    <path d="M12 11v6" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12-7.5Z" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const PanelLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);

export const CommandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
  </Svg>
);

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
    <path d="M19 15l.7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9Z" />
  </Svg>
);
