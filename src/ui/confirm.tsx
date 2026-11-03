import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

// Focus trap for our modal portals. When a prompt opens (`openId` is its id,
// null while that kind of prompt is closed), remember the element that had
// focus, then move focus into the panel, onto its `data-default-focus`
// control (else the first focusable one). It runs as a layout effect, in the
// same commit that shows the panel, so no keystroke lands behind it. The
// panels must not use `autoFocus`: React applies it earlier in that commit,
// so the trap would remember the panel's own button instead of the opener
// and focus would fall to the page when the prompt closes.
// While open, intercept Tab / Shift+Tab so focus wraps inside the panel
// instead of tabbing into the underlying app (which is inert to sighted
// users but reachable via keyboard/AT without this). On close, restore
// focus to the previously-focused element so keyboard users don't lose
// their place. The held-changes review dialog uses it too.
//
// Keyed on the prompt's id, not on "is one open": when one prompt follows
// another of the same kind the panel is a new element, and a trap still
// holding the old one would swallow every Tab.
export const useFocusTrap = (openId: number | null, panelRef: React.RefObject<HTMLDivElement | null>) => {
  useLayoutEffect(() => {
    if (openId === null) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    const getFocusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, input, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled"));
    // For a prompt that follows another of the same kind, the previous
    // trap's cleanup has just handed focus back to the opener, which this
    // trap then remembers in turn.
    if (!panel.contains(document.activeElement)) {
      (panel.querySelector<HTMLElement>("[data-default-focus]") ?? getFocusable()[0])?.focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !panel.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && previouslyFocused !== document.body) {
        previouslyFocused.focus?.();
      }
    };
  }, [openId, panelRef]);
};

// Themed replacement for the browser-native `confirm()` dialog. Anywhere in
// the tree, `useConfirm()` returns a function that opens the modal and
// resolves to true / false. Cross-platform (pure React + CSS), no native
// dialog quirks, and lets us style destructive actions consistently.

export interface ConfirmOptions {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Focus starts on Cancel: an Enter meant for something else (the
   *  terminal the prompt appeared over) can't answer yes. */
  safeDefault?: boolean;
}

type Resolver = (value: boolean) => void;

// File-conflict modal. Returned from useOverwritePrompt(). The caller picks
// one of five outcomes; in a batch operation, the "all" variants are sticky
// — caller stores them in batch state so subsequent files don't re-prompt.
export type OverwriteChoice =
  | "overwrite"
  | "skip"
  | "overwrite-all"
  | "skip-all"
  | "cancel";

export interface OverwritePromptOptions {
  /** Display name (just the basename, not the full path). */
  name: string;
  /** "download" or "upload" — drives the wording. */
  direction: "download" | "upload";
  /** Total number of items in the batch, so we can hide "all" when only one. */
  batchSize: number;
}

// Themed replacement for browser-native `prompt()`. Tauri's Android WebView
// silently no-ops native prompt(), which broke callers like "Generate SSH
// key" that need to collect a short string from the user. Resolves to the
// trimmed input (or empty string when the user hits OK with empty input,
// which validators should reject), or null when cancelled.
export interface TextPromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Mask the input (passwords / passphrases). */
  password?: boolean;
  /** Return the input untrimmed (secrets where spaces are significant). */
  keepWhitespace?: boolean;
  /** Return an error string to block OK; return null to allow. */
  validate?: (v: string) => string | null;
}

const ConfirmContext = createContext<((opts: ConfirmOptions | string) => Promise<boolean>) | null>(null);
const OverwriteContext = createContext<((opts: OverwritePromptOptions) => Promise<OverwriteChoice>) | null>(null);
const TextPromptContext = createContext<((opts: TextPromptOptions) => Promise<string | null>) | null>(null);

// A request for a prompt, waiting for its turn or on screen.
type Pending =
  | { id: number; kind: "confirm"; opts: ConfirmOptions; resolve: Resolver }
  | { id: number; kind: "overwrite"; opts: OverwritePromptOptions; resolve: (c: OverwriteChoice) => void }
  | { id: number; kind: "text"; opts: TextPromptOptions; resolve: (v: string | null) => void };

// How long a prompt that took another one's place ignores clicks and keys.
// The second click of a double-click, or a second quick Enter, was aimed at
// the prompt before it and must not answer this one too.
const CHAIN_GRACE_MS = 500;

const sameConfirm = (a: ConfirmOptions, b: ConfirmOptions) =>
  a.title === b.title && a.message === b.message && a.okLabel === b.okLabel &&
  a.cancelLabel === b.cancelLabel && !!a.destructive === !!b.destructive;

export const ConfirmProvider = ({ children }: { children: React.ReactNode }) => {
  // Every request, of any kind, waits in one line, and only the first in line
  // is on screen. There used to be one slot per kind, which went wrong two
  // ways:
  //  - A second request of the same kind replaced the first, whose promise
  //    then never settled. Two SFTP transfers that each reached an existing
  //    file left the first batch waiting for good.
  //  - Two kinds could be open at once, and one Enter answered both, the one
  //    hidden underneath included.
  //
  // The line is a ref so a request can be checked against it and added in one
  // synchronous step; `repaint` re-renders after each change.
  const queueRef = useRef<Pending[]>([]);
  const nextIdRef = useRef(1);
  // When the prompt on screen took the place of one just answered
  // (-Infinity: it opened on its own). See CHAIN_GRACE_MS.
  const chainedAtRef = useRef(-Infinity);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const [tpValue, setTpValue] = useState("");
  const [tpError, setTpError] = useState<string | null>(null);

  const active = queueRef.current[0] ?? null;
  const state = active?.kind === "confirm" ? active : null;
  const owState = active?.kind === "overwrite" ? active : null;
  const tpState = active?.kind === "text" ? active : null;

  // Refs to each modal's panel — the focus trap needs a DOM anchor to
  // determine "inside vs outside" for the Tab-cycle logic.
  const owPanelRef = useRef<HTMLDivElement | null>(null);
  const confirmPanelRef = useRef<HTMLDivElement | null>(null);
  const confirmOkRef = useRef<HTMLButtonElement | null>(null);
  const tpPanelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(owState?.id ?? null, owPanelRef);
  useFocusTrap(state?.id ?? null, confirmPanelRef);
  useFocusTrap(tpState?.id ?? null, tpPanelRef);

  // A text prompt starts from its own initial value, never from what was
  // typed into the one before it (which may have been a password).
  const primeText = useCallback((p: Pending | undefined) => {
    setTpValue(p?.kind === "text" ? p.opts.initialValue ?? "" : "");
    setTpError(null);
  }, []);

  const enqueue = useCallback((p: Pending) => {
    queueRef.current = [...queueRef.current, p];
    if (queueRef.current.length === 1) primeText(p);
    repaint();
  }, [primeText]);

  const confirm = useCallback((opts: ConfirmOptions | string) => {
    return new Promise<boolean>((resolve) => {
      const normalized = typeof opts === "string" ? { message: opts } : opts;
      // The same question already in line (the window asked to close again
      // while "Close Submarine?" is up) is not asked twice: the repeat is
      // answered "no" and the one already waiting stands.
      if (queueRef.current.some((p) => p.kind === "confirm" && sameConfirm(p.opts, normalized))) {
        resolve(false);
        return;
      }
      enqueue({ id: nextIdRef.current++, kind: "confirm", opts: normalized, resolve });
    });
  }, [enqueue]);

  const overwritePrompt = useCallback((opts: OverwritePromptOptions) => {
    return new Promise<OverwriteChoice>((resolve) => {
      enqueue({ id: nextIdRef.current++, kind: "overwrite", opts, resolve });
    });
  }, [enqueue]);

  const textPrompt = useCallback((opts: TextPromptOptions) => {
    return new Promise<string | null>((resolve) => {
      enqueue({ id: nextIdRef.current++, kind: "text", opts, resolve });
    });
  }, [enqueue]);

  // Take the prompt on screen out of the line and bring up the next one.
  // False when `p` is not the one on screen any more (already answered), or
  // only just took another prompt's place (see CHAIN_GRACE_MS): the caller
  // must then leave it unanswered.
  const advance = (p: Pending) => {
    if (queueRef.current[0] !== p) return false;
    if (performance.now() - chainedAtRef.current < CHAIN_GRACE_MS) return false;
    queueRef.current = queueRef.current.slice(1);
    chainedAtRef.current = queueRef.current.length > 0 ? performance.now() : -Infinity;
    primeText(queueRef.current[0]);
    repaint();
    return true;
  };

  const close = (value: boolean) => {
    if (state && advance(state)) state.resolve(value);
  };
  const closeOverwrite = (choice: OverwriteChoice) => {
    if (owState && advance(owState)) owState.resolve(choice);
  };
  const closeTextPrompt = (value: string | null) => {
    if (tpState && advance(tpState)) tpState.resolve(value);
  };
  const submitTextPrompt = () => {
    if (!tpState) return;
    // `keepWhitespace` returns the input exactly as typed (e.g. a sudo
    // password, where leading/trailing spaces are part of the secret).
    const v = tpState.opts.keepWhitespace ? tpValue : tpValue.trim();
    const err = tpState.opts.validate?.(v) ?? null;
    if (err) { setTpError(err); return; }
    closeTextPrompt(v);
  };

  // Esc cancels, Enter confirms — matches the native dialog conventions so
  // muscle memory keeps working. A key still held down from before (auto
  // repeat) answers nothing: it was not pressed for this prompt. In a prompt
  // whose default is Cancel (`safeDefault`), Enter does what the focused
  // button does, so an Enter alone never says yes.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!e.repeat) close(false); }
      if (e.key === "Enter")  {
        e.preventDefault();
        if (!e.repeat) close(state.opts.safeDefault ? document.activeElement === confirmOkRef.current : true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Same Esc/Enter wiring for the overwrite modal. Esc cancels the whole
  // batch; Enter picks "Overwrite" (the most common "yes I meant it" path).
  useEffect(() => {
    if (!owState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!e.repeat) closeOverwrite("cancel"); }
      if (e.key === "Enter")  { e.preventDefault(); if (!e.repeat) closeOverwrite("overwrite"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owState]);

  // Esc cancels the text prompt. Enter submits (validate → resolve). The
  // input itself handles Enter via onKeyDown so this only catches Esc when
  // the input has focus and when it doesn't.
  useEffect(() => {
    if (!tpState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!e.repeat) closeTextPrompt(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpState]);

  return (
    <ConfirmContext.Provider value={confirm}>
     <OverwriteContext.Provider value={overwritePrompt}>
      <TextPromptContext.Provider value={textPrompt}>
      {children}
      {/* Each dialog is keyed by its prompt, so one that follows another of
          the same kind is a new dialog (it animates in and its default
          control takes focus) and not the old one with the text swapped. */}
      {owState && createPortal(
        <PromptShell key={owState.id} panelRef={owPanelRef} titleId="overwrite-modal-title" onDismiss={() => closeOverwrite("cancel")}
          title={owState.opts.direction === "download" ? "Replace the local file?" : "Replace the file on the server?"}
          icon={<AlertTriangle size={16} className="text-warning" aria-hidden />}
          footer={<>
            <button onClick={() => closeOverwrite("cancel")} className="btn btn-ghost mr-auto">
              {owState.opts.batchSize > 1 ? "Stop transfer" : "Cancel"}
            </button>
            {owState.opts.batchSize > 1 && (
              <button onClick={() => closeOverwrite("skip-all")} className="btn">Skip all</button>
            )}
            <button onClick={() => closeOverwrite("skip")} className="btn">Skip</button>
            {owState.opts.batchSize > 1 && (
              <button onClick={() => closeOverwrite("overwrite-all")} className="btn">Replace all</button>
            )}
            <button onClick={() => closeOverwrite("overwrite")} data-default-focus className="btn btn-primary">Replace</button>
          </>}
        >
          <p className="text-zinc-300 leading-[18px]">
            {owState.opts.direction === "download"
              ? "A file with this name is already in the destination folder:"
              : "A file with this name is already on the server:"}
          </p>
          <p className="mt-1.5 font-mono text-[12px] text-white break-all">{owState.opts.name}</p>
        </PromptShell>,
        document.body
      )}
      {state && createPortal(
        <PromptShell key={state.id} panelRef={confirmPanelRef} titleId="confirm-modal-title" onDismiss={() => close(false)}
          title={state.opts.title || (state.opts.destructive ? "Confirm action" : "Are you sure?")}
          icon={state.opts.destructive ? <AlertTriangle size={16} className="text-danger" aria-hidden /> : null}
          footer={<>
            <button onClick={() => close(false)}
                    data-default-focus={state.opts.safeDefault ? true : undefined}
                    className="btn">
              {state.opts.cancelLabel || "Cancel"}
            </button>
            <button onClick={() => close(true)} ref={confirmOkRef}
                    data-default-focus={state.opts.safeDefault ? undefined : true}
                    className={`btn ${state.opts.destructive ? "btn-danger" : "btn-primary"}`}>
              {state.opts.okLabel || (state.opts.destructive ? "Delete" : "OK")}
            </button>
          </>}
        >
          <p className="text-zinc-300 leading-[18px] whitespace-pre-wrap break-words">{state.opts.message}</p>
        </PromptShell>,
        document.body
      )}
      {tpState && createPortal(
        <PromptShell key={tpState.id} panelRef={tpPanelRef} titleId="text-prompt-modal-title" onDismiss={() => closeTextPrompt(null)}
          title={tpState.opts.title || "Enter value"}
          footer={<>
            <button onClick={() => closeTextPrompt(null)} className="btn">{tpState.opts.cancelLabel || "Cancel"}</button>
            <button onClick={submitTextPrompt} className="btn btn-primary">{tpState.opts.okLabel || "OK"}</button>
          </>}
        >
          {tpState.opts.message && (
            <p id="text-prompt-modal-message" className="mb-3 text-zinc-300 leading-[18px] whitespace-pre-wrap break-words">
              {tpState.opts.message}
            </p>
          )}
          <input
            data-default-focus
            type={tpState.opts.password ? "password" : "text"}
            value={tpValue}
            onChange={(e) => { setTpValue(e.target.value); setTpError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) submitTextPrompt(); } }}
            placeholder={tpState.opts.placeholder}
            aria-label={tpState.opts.title || "Value"}
            aria-describedby={tpState.opts.message ? "text-prompt-modal-message" : undefined}
            aria-invalid={tpError ? true : undefined}
            aria-errormessage={tpError ? "text-prompt-modal-error" : undefined}
            className="field"
          />
          {tpError && (
            <p id="text-prompt-modal-error" role="alert" className="mt-1.5 text-[12px] text-danger">{tpError}</p>
          )}
        </PromptShell>,
        document.body
      )}
      </TextPromptContext.Provider>
     </OverwriteContext.Provider>
    </ConfirmContext.Provider>
  );
};

// The sheet every prompt sits in: scrim, title row, body, buttons on the right.
const PromptShell = ({ panelRef, titleId, title, icon, onDismiss, footer, children }: {
  panelRef: React.MutableRefObject<HTMLDivElement | null>;
  titleId: string;
  title: string;
  icon?: React.ReactNode;
  onDismiss: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="fixed inset-0 z-[9999] bg-scrim flex items-center justify-center p-4" onClick={onDismiss}>
    <div ref={panelRef}
         role="dialog"
         aria-modal="true"
         aria-labelledby={titleId}
         onClick={(e) => e.stopPropagation()}
         className="w-full max-w-[400px] bg-elevated rounded-xl shadow-sheet text-[13px] animate-in zoom-in-95 fade-in duration-150">
      <div className="flex items-start gap-2.5 px-4 pt-4 pb-2">
        {icon && <span className="mt-px shrink-0">{icon}</span>}
        <h2 id={titleId} className="flex-1 min-w-0 text-[15px] font-semibold text-white">{title}</h2>
        <button type="button" aria-label="Close" onClick={onDismiss} className="icon-btn -mr-1 -mt-0.5"><X size={14} /></button>
      </div>
      <div className="px-4 pb-4">{children}</div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t border-white/[0.075]">{footer}</div>
    </div>
  </div>
);

export const useTextPrompt = () => {
  const ctx = useContext(TextPromptContext);
  if (!ctx) throw new Error("useTextPrompt must be used within <ConfirmProvider>");
  return ctx;
};

export const useConfirm = () => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
};

export const useOverwritePrompt = () => {
  const ctx = useContext(OverwriteContext);
  if (!ctx) throw new Error("useOverwritePrompt must be used within <ConfirmProvider>");
  return ctx;
};
