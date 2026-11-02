import type { ReactNode } from "react";

// A row of a server's options: its label and control, and under them what it
// does. The server form and the RDP and VNC tabs' panels use the same ones.

// Speed and quality in one go: the sets of choices side by side, the one the
// choices are now marked (none: the user's own mix), and what it does under them.
export function QuickChoiceRow<T extends string>({ choices, current, onPick, hint }: {
  choices: { value: T; label: string }[];
  current: T | null;
  onPick: (value: T) => void;
  hint: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center gap-3">
        <span className="text-zinc-400 shrink-0">Quick choice</span>
        <div role="radiogroup" aria-label="Quick choice" className="seg flex-1 min-w-0 grid grid-cols-3">
          {choices.map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={current === p.value}
              onClick={() => onPick(p.value)}
              className={`seg-item truncate ${current === p.value ? "bg-control text-white shadow-control" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11.5px] text-zinc-500 leading-[15px]">{hint}</p>
    </div>
  );
}

// A choice from a list.
export function ChoiceRow({ label, hint, value, onChange, choices }: {
  label: string;
  hint?: string;
  value: string | number;
  onChange: (value: string) => void;
  choices: { value: string | number; label: string; disabled?: boolean }[];
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center gap-3">
        <label className="text-zinc-400 shrink-0">{label}</label>
        <select
          aria-label={label}
          className="field flex-1 min-w-0 w-auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value} disabled={c.disabled}>{c.label}</option>
          ))}
        </select>
      </div>
      {hint && <p className="text-[11.5px] text-zinc-500 leading-[15px]">{hint}</p>}
    </div>
  );
}

// An on/off switch.
export function SwitchRow({ label, hint, checked, onChange }: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium text-white">{label}</div>
        {hint && <div className="text-[11.5px] text-zinc-500 leading-[15px]">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        role="switch"
        aria-label={label}
        aria-checked={checked}
        className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${checked ? "bg-primary" : "bg-white/[0.08]"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${checked ? "translate-x-[14px]" : ""}`} />
      </button>
    </div>
  );
}
