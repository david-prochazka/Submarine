import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, X, ShieldAlert, KeyRound } from "lucide-react";

// The host-key and keyboard-interactive (2FA / password) prompts of a
// connection, as an SSH tab and an RDP tab (issue #3, its SSH server) show
// them. State and answers stay with the tab; this only draws them.
export function AuthPrompts({
  fingerprintPrompt,
  kbiPrompt,
  kbiValues,
  setKbiValues,
  kbiFirstInputRef,
  handleFingerprintResponse,
  handleKbiSubmit,
  handleKbiCancel,
  serverName,
  displayName,
}: {
  fingerprintPrompt: any;
  kbiPrompt: any;
  kbiValues: string[];
  setKbiValues: Dispatch<SetStateAction<string[]>>;
  kbiFirstInputRef?: MutableRefObject<HTMLInputElement | null>;
  handleFingerprintResponse: (accepted: boolean) => void;
  handleKbiSubmit: () => void;
  handleKbiCancel: () => void;
  serverName: string;
  displayName?: string;
}) {
  // A password prompt may offer "Save password" (the backend says so, and
  // saves it once the login with it worked); ticked to start with unless the
  // backend says otherwise (a login that also tried keys).
  const offerSave = !!kbiPrompt?.save;
  const ticked = kbiPrompt?.save?.checked !== false;
  const [save, setSave] = useState(ticked);
  const nonce = kbiPrompt?.nonce;
  useEffect(() => { setSave(ticked); }, [nonce, ticked]);
  const submit = async () => {
    if (offerSave && nonce) await invoke("kbi_save_choice", { nonce, save }).catch(() => {});
    handleKbiSubmit();
  };
  return (
  <>
    {/* Fingerprint Prompt — two flavors:
          • mismatch=false → first time seeing this host, light warning
          • mismatch=true  → host key CHANGED, looks like a MITM,
                             red treatment + explicit copy that lists
                             the old fingerprints we used to trust */}
    {fingerprintPrompt && (() => {
      const isMismatch = !!fingerprintPrompt.mismatch;
      // An RDP server proves itself with a certificate, an SSH server with a key.
      const isCert = fingerprintPrompt.keyType === "RDP certificate";
      const what = isCert ? "certificate" : "key";
      const tone = isMismatch
        ? "from-danger/[0.08] to-danger/[0.08] shadow-sheet ring-[0.5px] ring-inset ring-danger/45"
        : "from-warning/[0.08] to-warning/[0.08] shadow-sheet ring-[0.5px] ring-inset ring-warning/40";
      const accent = isMismatch ? "text-danger" : "text-warning";
      return (
      <div className={`mt-6 p-4 bg-elevated bg-gradient-to-b ${tone} rounded-[10px] text-[13px] animate-in fade-in slide-in-from-bottom-4`}>
        <div className="flex items-start gap-3">
          <ShieldAlert className={`${accent} mt-0.5 shrink-0`} size={18} aria-hidden />
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-white">
              {isMismatch ? (isCert ? "The server's certificate has changed" : "The server's host key has changed") : "New server: check its fingerprint"}
            </h3>
            {isMismatch ? (
              <p className="text-zinc-300 mt-2 mb-4 leading-relaxed">
                The host '{fingerprintPrompt.host}' is presenting a different {what} than the one you trusted before. This is what a man-in-the-middle attack looks like — but it can also mean the server admin {isCert ? "renewed the certificate" : "rotated the key"}.<br/><br/>
                New {fingerprintPrompt.keyType} fingerprint: <span className="text-white font-mono text-[12px] break-all">{fingerprintPrompt.fingerprint}</span><br/>
                {Array.isArray(fingerprintPrompt.priorFingerprints) && fingerprintPrompt.priorFingerprints.length > 0 && (
                  <span className="block mt-1 text-zinc-500 text-[11px]">
                    Previously trusted: <span className="font-mono break-all">{fingerprintPrompt.priorFingerprints.join(", ")}</span>
                  </span>
                )}
                <span className="block mt-3 text-danger text-[12px]">Verify the new fingerprint out-of-band (call the admin, check the server console) before accepting.</span>
              </p>
            ) : (
              <p className="text-zinc-400 mt-2 mb-4 leading-relaxed">
                The authenticity of host '{fingerprintPrompt.host}' can't be established.<br/>
                {fingerprintPrompt.keyType}{isCert ? "" : " key"} fingerprint is <span className="text-white font-mono text-[12px] break-all">{fingerprintPrompt.fingerprint}</span>.<br/>
                Are you sure you want to continue connecting?
              </p>
            )}
            {/* On a phone the two share the row, or each takes a full row
                when they don't fit — never a label broken over two lines. */}
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <button
                onClick={() => handleFingerprintResponse(true)}
                className={`btn h-8 flex-1 sm:flex-none ${isMismatch ? "btn-danger" : "btn-primary"}`}
              >
                <Check size={14} aria-hidden /> {isMismatch ? `Trust the new ${what}` : "Trust and connect"}
              </button>
              <button
                onClick={() => handleFingerprintResponse(false)}
                className="btn h-8 flex-1 sm:flex-none"
              >
                <X size={14} aria-hidden /> {isMismatch ? "Don't connect" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      </div>
      );
    })()}

    {/* Keyboard-Interactive (2FA / verification-code) prompt. The
        server drives the wording via `name` / `instructions` / each
        prompt's label; we render one input per prompt (masked unless
        the server set echo=true, e.g. a plain username). Enter on the
        last field submits. */}
    {kbiPrompt && (
      <div className="mt-6 p-4 bg-elevated bg-gradient-to-b from-primary/[0.06] to-primary/[0.06] shadow-sheet ring-[0.5px] ring-inset ring-primary/40 rounded-[10px] text-[13px] animate-in fade-in slide-in-from-bottom-4">
        <div className="flex items-start gap-3">
          <KeyRound className="text-primary mt-0.5 shrink-0" size={18} aria-hidden />
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-white">
              {kbiPrompt.name && String(kbiPrompt.name).trim() ? kbiPrompt.name : "Verification required"}
            </h3>
            {/* Which server is asking — the server's own wording rarely
                says, and several tabs can be connecting at once. */}
            <p className="mt-0.5 text-[11.5px] text-zinc-500 truncate" title={serverName}>
              {displayName || serverName}
            </p>
            {kbiPrompt.instructions && String(kbiPrompt.instructions).trim() && (
              <p className="text-zinc-400 mt-2 leading-relaxed whitespace-pre-wrap break-words">
                {kbiPrompt.instructions}
              </p>
            )}
            <div className="mt-3 space-y-3">
              {(kbiPrompt.prompts || []).map((p: any, i: number) => (
                <div key={i} className="space-y-1.5">
                  <label className="block text-[12px] text-zinc-300 break-words">
                    {p?.prompt || "Response"}
                  </label>
                  <input
                    type={p?.echo ? "text" : "password"}
                    ref={i === 0 ? kbiFirstInputRef : undefined}
                    className="field h-8"
                    // A login name or code, never prose: a phone keyboard
                    // must not capitalise "alice" into "Alice".
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={kbiValues[i] ?? ""}
                    onChange={e => setKbiValues(vals => {
                      const next = [...vals];
                      next[i] = e.target.value;
                      return next;
                    })}
                    onKeyDown={e => {
                      if (e.key === "Enter" && i === (kbiPrompt.prompts?.length ?? 1) - 1) void submit();
                    }}
                  />
                </div>
              ))}
            </div>
            {offerSave && (
              <label className="mt-3 flex items-start gap-2 text-[12px] text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>
                  {String(kbiPrompt.save?.label || "Save password")}
                  <span className="block text-[11px] text-zinc-500">Kept in this profile's encrypted vault once the login with it works.</span>
                  {kbiPrompt.save?.note && (
                    <span className="block text-[11px] text-amber-400/80">{String(kbiPrompt.save.note)}</span>
                  )}
                </span>
              </label>
            )}
            <div className="flex flex-wrap gap-2 sm:gap-3 mt-4">
              <button
                onClick={() => void submit()}
                className="btn btn-primary h-8 flex-1 sm:flex-none"
              >
                <Check size={14} aria-hidden /> Submit
              </button>
              <button
                onClick={handleKbiCancel}
                className="btn h-8 flex-1 sm:flex-none"
              >
                <X size={14} aria-hidden /> Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
  </>
  );
}
