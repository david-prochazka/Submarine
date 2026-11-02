import { useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronUp, Download, FolderOpen, Trash2, Upload, X } from "lucide-react";
import { IS_ANDROID } from "../util/platform";

// One upload, download or long folder delete, as the backend reports it on
// `sftp-transfer-{session}` (~10 times a second), plus what the workspace
// works out from those reports: when it started and ended, and its speed.
export interface Transfer {
  id: string;
  name: string;
  kind: "upload" | "download" | "delete";
  /** Where it comes from and where it goes: a file's full path, or for a folder the folder it goes into. Not on deletes. */
  from?: string;
  to?: string;
  dir?: boolean;
  /** Bytes so far; for a delete, the entries removed so far. */
  bytes: number;
  total: number;
  status: "progress" | "done" | "error" | "cancelled";
  error?: string | null;
  startedAt: number;
  endedAt?: number;
  /** Bytes per second, smoothed. */
  speed?: number;
  sampleBytes?: number;
  sampleAt?: number;
}

export type TransferFix = "retry" | "sudo";

export const formatBytes = (n: number) => {
  if (!n) return "0 B";
  const k = 1024, units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDuration = (s: number) => {
  if (s < 10) return `${Math.max(0.1, Math.round(s * 10) / 10)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

// The folder a transfer lands in, by its last name: "releases/".
const destFolder = (t: Transfer) => {
  if (!t.to) return "";
  const dir = t.dir ? t.to : t.to.replace(/[\\/][^\\/]*$/, "") || t.to.slice(0, 1);
  const trimmed = dir.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop();
  return last ? `${last}/` : dir;
};

// Why a transfer failed, in words, and what may fix it.
export const explainFailure = (t: Transfer, canSudo: boolean): { text: string; fix?: TransferFix } => {
  const raw = t.error || "";
  if (/permission denied|access is denied|EACCES|not permitted/i.test(raw)) {
    const what = t.kind === "upload"
      ? "Permission denied: this folder on the server isn't writable for your login."
      : "Permission denied: the file can't be read with your login, or the folder here isn't writable.";
    return canSudo
      ? { text: `${what} Retry as root, or pick a folder you own.`, fix: "sudo" }
      : { text: `${what} Pick a folder you own.` };
  }
  if (/no space|disk full|quota/i.test(raw)) return { text: "The disk is full. Free some space and retry.", fix: "retry" };
  if (/no such file|not found|does not exist/i.test(raw)) return { text: "It isn't there any more. Refresh the folder and try again." };
  if (/connection|channel|closed|eof|broken pipe|timed out|reset by peer|disconnect/i.test(raw)) {
    return { text: "The connection dropped. Retry once it's back.", fix: "retry" };
  }
  return { text: raw || "It failed.", fix: t.from && t.to ? "retry" : undefined };
};

interface TransferQueueProps {
  transfers: Transfer[];
  open: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  onClearFinished: () => void;
  onFix: (t: Transfer, fix: TransferFix) => void;
  /** Show a finished download in the file manager. */
  onReveal: (t: Transfer) => void;
  /** Whether "Retry as root" can help: the remote pane isn't root already. */
  canSudo: boolean;
}

// The drawer along the bottom of Files: every transfer of this session with
// its progress, how it ended, and for a failure why and what to do.
const TransferQueue = ({ transfers, open, onToggle, onCancel, onClearFinished, onFix, onReveal, canSudo }: TransferQueueProps) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0) setCompact(el.clientWidth < 560);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const active = transfers.filter((t) => t.status === "progress");
  const failed = transfers.filter((t) => t.status === "error").length;
  const finished = transfers.length - active.length;
  const speed = active.reduce((sum, t) => sum + (t.kind === "delete" ? 0 : t.speed || 0), 0);

  return (
    <section ref={rootRef} aria-label="Transfers" className="shrink-0 border-t border-white/[0.14] bg-panel">
      <div className="h-[38px] flex items-center gap-2.5 pl-4 pr-2.5">
        <h2 className="text-[13px] font-semibold text-white">Transfers</h2>
        {active.length > 0 && <span className="pill bg-white/[0.06] text-zinc-400">{active.length} active</span>}
        {failed > 0 && <span className="pill bg-danger/[0.12] text-danger">{failed} failed</span>}
        {speed > 0 && !compact && <span className="text-[12px] text-zinc-400 tabular-nums">{formatBytes(speed)}/s</span>}
        <span className="flex-1" />
        {finished > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
        <button
          type="button"
          className="icon-btn w-6 h-6"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Hide transfers" : "Show transfers"}
          title={open ? "Hide transfers" : "Show transfers"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {open && (
        <ul className="max-h-[200px] overflow-y-auto">
          {transfers.map((t) => (
            <TransferRow key={t.id} t={t} compact={compact} canSudo={canSudo} onCancel={onCancel} onFix={onFix} onReveal={onReveal} />
          ))}
        </ul>
      )}
    </section>
  );
};

const TransferRow = ({ t, compact, canSudo, onCancel, onFix, onReveal }: {
  t: Transfer;
  compact: boolean;
  canSudo: boolean;
  onCancel: (id: string) => void;
  onFix: (t: Transfer, fix: TransferFix) => void;
  onReveal: (t: Transfer) => void;
}) => {
  const pct = t.total > 0 ? Math.min(100, (t.bytes * 100) / t.total) : 0;
  const failure = t.status === "error" ? explainFailure(t, canSudo) : null;
  const folder = destFolder(t);

  const status =
    failure ? failure.text
    : t.status === "cancelled" ? (t.error ? `Cancelled. ${t.error}` : "Cancelled")
    : t.status === "done" ? [`Done in ${formatDuration(((t.endedAt ?? t.startedAt) - t.startedAt) / 1000)}`, t.error].filter(Boolean).join(". ")
    : t.kind === "delete" ? "Deleting…"
    : t.bytes === 0 ? (t.dir && t.total === 0 ? "Counting files…" : "Waiting")
    : t.speed && t.total > t.bytes ? `${formatBytes(t.speed)}/s, ${formatDuration((t.total - t.bytes) / t.speed)} left`
    : "Working…";

  const size =
    t.kind === "delete" ? `${t.bytes.toLocaleString()} removed`
    : t.status === "progress" && t.total > 0 ? `${formatBytes(t.bytes)} of ${formatBytes(t.total)}`
    : formatBytes(t.total || t.bytes);

  const barWidth = t.status === "progress" ? (t.total > 0 ? `${pct}%` : t.kind === "delete" ? "100%" : "0%") : "100%";
  const barTone =
    t.status === "error" ? "bg-danger"
    : t.status === "done" ? "bg-success"
    : t.status === "cancelled" ? "bg-zinc-500"
    : "bg-primary";

  const Icon =
    t.status === "error" ? AlertTriangle
    : t.status === "cancelled" ? Ban
    : t.kind === "upload" ? Upload
    : t.kind === "delete" ? Trash2
    : Download;

  const action =
    t.status === "progress" ? (
      <button type="button" className="icon-btn w-6 h-6" onClick={() => onCancel(t.id)} aria-label={`Cancel ${t.name}`} title="Cancel">
        <X size={13} />
      </button>
    ) : failure?.fix ? (
      <button type="button" className="btn btn-sm" onClick={() => onFix(t, failure.fix!)}>
        {failure.fix === "sudo" ? "Retry as root" : "Retry"}
      </button>
    ) : t.status === "done" && t.kind === "download" && t.to && !IS_ANDROID ? (
      <button type="button" className="icon-btn w-6 h-6" onClick={() => onReveal(t)} aria-label={`Show ${t.name} in its folder`} title="Show in folder">
        <FolderOpen size={13} />
      </button>
    ) : null;

  const name = (
    <span className="min-w-0">
      <span className="block truncate font-medium text-white" title={t.from || t.name}>{t.name}</span>
      {folder && (
        <span className="block truncate font-mono text-[11px] text-zinc-500" title={t.to}>
          to {folder}
        </span>
      )}
    </span>
  );
  const progress = (
    <span className="min-w-0">
      <span className="block h-1 rounded-sm bg-white/[0.06] overflow-hidden">
        <span
          className={`block h-full rounded-sm ${barTone} transition-[width] duration-150 ${t.kind === "delete" && t.status === "progress" ? "animate-pulse" : ""}`}
          style={{ width: barWidth }}
        />
      </span>
      <span
        className={`block mt-1 text-[11.5px] ${failure ? "line-clamp-2" : "truncate"} ${failure ? "text-danger" : t.status === "cancelled" && t.error ? "text-warning" : "text-zinc-500"}`}
        title={t.error || status}
      >
        {status}
      </span>
    </span>
  );
  const icon = <Icon size={14} className={failure ? "text-danger" : "text-zinc-400"} aria-hidden="true" />;

  return (
    <li className="border-t border-white/[0.075] px-4">
      {compact ? (
        <div className="py-2 grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-center">
          {icon}
          {name}
          <span className="flex items-center justify-end">{action}</span>
          <span className="col-start-2 col-span-2">{progress}</span>
        </div>
      ) : (
        <div className="h-10 grid grid-cols-[16px_minmax(0,220px)_minmax(0,1fr)_130px_100px] gap-3 items-center">
          {icon}
          {name}
          {progress}
          <span className="text-[12px] text-zinc-400 tabular-nums truncate">{size}</span>
          <span className="flex items-center justify-end">{action}</span>
        </div>
      )}
    </li>
  );
};

export default TransferQueue;
