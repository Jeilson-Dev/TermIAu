import type { ReactElement } from "react";
import type { FileStatus } from "../types";

const PATHS = {
  "chevron-down": <path d="M4 6l4 4 4-4" />,
  "chevron-right": <path d="M6 4l4 4-4 4" />,
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  "arrow-right": <path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" />,
  "arrow-left": <path d="M13 8H3M6.5 4.5L3 8l3.5 3.5" />,
  folder: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  ),
  "folder-open": (
    <path d="M2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h3.8A1.5 1.5 0 0 1 13 6v.7M2 11.5l1.6-4.2a1 1 0 0 1 .94-.65h9.2a.6.6 0 0 1 .57.8l-1.4 4.3a1.5 1.5 0 0 1-1.43 1.05H3.5A1.5 1.5 0 0 1 2 11.5z" />
  ),
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  "expand-up": <path d="M8 13V5.5M5 8.5l3-3 3 3M3.5 2.5h9" />,
  "expand-down": <path d="M8 3v7.5M5 7.5l3 3 3-3M3.5 13.5h9" />,
  unfold: <path d="M5 5.5l3-3 3 3M5 10.5l3 3 3-3M3.5 8h9" />,
  bookmark: <path d="M4.5 2.5h7v11L8 11l-3.5 2.5z" />,
  trash: (
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.6a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8.6" />
  ),
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  split: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </>
  ),
  unified: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 6h7M4.5 10h7" />
    </>
  ),
  "git-branch": (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="4.5" r="1.5" />
      <path d="M4.5 5v6M11.5 6c0 3-7 2-7 5" />
    </>
  ),
  "no-entry": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </>
  ),
  warning: <path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.5v.01" />,
  history: <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3M8 5.5V8l2 1.5" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, size = 16 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

const dot = <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />;
const arrow = <path d="M5 8h6M9 6l2 2-2 2" />;

const STATUS: Record<FileStatus, { className: string; label: string; symbol: ReactElement }> = {
  added: { className: "added", label: "Adicionado", symbol: <path d="M8 5.5v5M5.5 8h5" /> },
  modified: { className: "modified", label: "Modificado", symbol: dot },
  deleted: { className: "deleted", label: "Removido", symbol: <path d="M5.5 8h5" /> },
  renamed: { className: "renamed", label: "Renomeado", symbol: arrow },
  copied: { className: "renamed", label: "Copiado", symbol: arrow },
  typeChanged: { className: "modified", label: "Tipo alterado", symbol: dot },
};

export function StatusIcon({ status }: { status: FileStatus }) {
  const { className, label, symbol } = STATUS[status];
  return (
    <svg
      className={`status-icon ${className}`}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      {symbol}
    </svg>
  );
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total ? Math.round((additions / total) * 5) : 0;
  const red = total ? 5 - green : 0;
  return (
    <span className="diffstat" title={`${additions} adições, ${deletions} remoções`}>
      <span className="add">+{additions}</span>
      <span className="del">−{deletions}</span>
      <span className="blocks">
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} className={i < green ? "add" : i < green + red ? "del" : undefined} />
        ))}
      </span>
    </span>
  );
}
