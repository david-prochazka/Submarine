import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { CheckSquare, Download, Square, X } from "lucide-react";
import { useConfirm } from "../ui/confirm";
import type { ImportRequest } from "./ServersEmpty";

// Shape returned by `parse_ssh_config` and `parse_client_import`: one entry
// per non-wildcard alias.
type ImportedHost = {
  host_alias: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string | null;
  proxy_jump: string | null;
};

// What `import_ssh_key_file` hands back after putting a key file in the vault.
type ImportedSshKey = {
  id: number;
  name: string;
  reused: boolean;
  encrypted: boolean;
};

export type NumberedImportRequest = ImportRequest & { n: number };

const errText = (e: any) => (typeof e === "string" ? e : e?.message || String(e));

// Hosts from ~/.ssh/config, or from a PuTTY / MobaXterm / JSON export (the
// backend detects which), added as servers. Opened from the editor's header
// (`open`) or by the servers home's empty state (`request`).
export default function ServerImportDialog({ open, request, onClose, refreshServers, refreshSshKeys }: {
  open: boolean;
  request?: NumberedImportRequest | null;
  onClose: () => void;
  refreshServers?: () => unknown;
  refreshSshKeys?: () => unknown;
}) {
  const confirm = useConfirm();
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The import worked, and there's something to follow up (a key that still
  // needs its passphrase).
  const [notice, setNotice] = useState<string | null>(null);
  const [hosts, setHosts] = useState<ImportedHost[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<"ssh" | "paste">("ssh");
  const [pasteText, setPasteText] = useState("");

  const reset = () => {
    setError(null);
    setNotice(null);
    setHosts([]);
    setSelected(new Set());
  };

  // Fresh from ~/.ssh/config every time, so an edit between imports shows.
  const readSshConfig = async () => {
    reset();
    setLoading(true);
    try {
      setHosts(await invoke<ImportedHost[]>("parse_ssh_config", { path: null }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };

  const parsePasted = async (text: string = pasteText) => {
    reset();
    setLoading(true);
    try {
      setHosts(await invoke<ImportedHost[]>("parse_client_import", { text }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setShown(true);
    setSource("ssh");
    setPasteText("");
    readSshConfig();
  }, [open]);

  useEffect(() => {
    if (!request) return;
    setShown(true);
    if (request.source === "ssh") {
      setSource("ssh");
      setPasteText("");
      readSshConfig();
      return;
    }
    setSource("paste");
    setPasteText(request.text);
    parsePasted(request.text);
  }, [request?.n]);

  const switchSource = (next: "ssh" | "paste") => {
    if (busy || source === next) return;
    setSource(next);
    reset();
    if (next === "ssh") readSshConfig();
  };

  const close = () => {
    if (busy) return;
    setShown(false);
    reset();
    setPasteText("");
    onClose();
  };

  // Focus moves in, so Escape (handled on the dialog) reaches it. Its key
  // events stop here: React carries them through the portal to the editor.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (shown) dialogRef.current?.focus({ preventScroll: true });
  }, [shown]);

  const toggleAll = () => setSelected(selected.size === hosts.length ? new Set() : new Set(hosts.map((h) => h.host_alias)));
  const toggleOne = (alias: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });

  // One `add_server` per ticked host. A host that names an IdentityFile comes
  // in with that key; the rest as "custom_pass" with no password, asked for
  // on connect. A host that fails doesn't stop the others.
  const importSelected = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let ok = 0;
    let failed = 0;
    let lastErr: string | null = null;
    // Hosts often share a key file: read and store each once. `null` is a
    // path already tried that couldn't be used.
    const keysByPath = new Map<string, ImportedSshKey | null>();
    let keysAttached = 0;
    let keysNeedingPassphrase = 0;
    // Key files from this computer, going into a shared profile, would sync
    // to everyone it's shared with: ask first. The safe answer imports the
    // hosts without them.
    const keyFiles = [...new Set(hosts.filter((h) => selected.has(h.host_alias) && h.identity_file).map((h) => h.identity_file as string))];
    let withKeys = true;
    if (keyFiles.length > 0) {
      const shared = await invoke<{ current: string | null }>("share_key_state").then((s) => !!s.current).catch(() => false);
      if (shared) {
        withKeys = await confirm({
          title: "Add your key files to a shared profile?",
          message:
            `This profile is shared. ${keyFiles.length === 1 ? "This private key" : "These private keys"} from this computer would go to everyone you share it with: ` +
            `${keyFiles.join(", ")}. Import the hosts with ${keyFiles.length === 1 ? "it" : "them"}, or without (you can pick keys for them later)?`,
          okLabel: "Import with keys",
          cancelLabel: "Without keys",
          safeDefault: true,
        });
      }
    }
    for (const host of hosts) {
      if (!selected.has(host.host_alias)) continue;
      let key: ImportedSshKey | null = null;
      if (host.identity_file && withKeys) {
        if (keysByPath.has(host.identity_file)) {
          key = keysByPath.get(host.identity_file) ?? null;
        } else {
          try {
            key = await invoke<ImportedSshKey>("import_ssh_key_file", { path: host.identity_file, name: null });
          } catch {
            // An unreadable IdentityFile still leaves a host worth having.
            key = null;
          }
          keysByPath.set(host.identity_file, key);
          if (key) {
            keysAttached++;
            if (key.encrypted) keysNeedingPassphrase++;
          }
        }
      }
      try {
        await invoke<number>("add_server", {
          name: host.host_alias,
          host: host.hostname || host.host_alias,
          port: host.port || 22,
          // No user in the export: left blank, so connecting asks "Login as".
          username: host.user ? host.user.trim() : "",
          password: null,
          credentialId: null,
          folderId: null,
          proxyType: "none",
          proxyHost: "",
          proxyPort: 1080,
          tunnels: [],
          authType: key ? "custom_key" : "custom_pass",
          keyId: key ? key.id : null,
          autostart: false,
          mirrors: [],
          color: null,
        });
        ok++;
      } catch (e) {
        failed++;
        lastErr = errText(e);
      }
    }
    setBusy(false);
    if (failed > 0) setError(`${ok} imported, ${failed} failed${lastErr ? `: ${lastErr}` : ""}`);
    try { await refreshServers?.(); } catch { /* the list refreshes on its own later */ }
    if (keysAttached > 0) {
      try { await refreshSshKeys?.(); } catch { /* same */ }
    }
    // A key's passphrase isn't in the config file: say so rather than leave
    // the import quietly half done.
    if (keysNeedingPassphrase > 0) {
      setNotice(
        `${ok} imported, ${keysAttached} SSH key${keysAttached === 1 ? "" : "s"} attached. ` +
        `${keysNeedingPassphrase} of them need a passphrase: add it under Logins, or leave it empty to be asked when connecting.`,
      );
      return;
    }
    if (failed === 0) close();
  };

  if (!shown) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-scrim flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); close(); }}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-import-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
        className="w-full max-w-[520px] max-h-[80vh] flex flex-col bg-elevated rounded-xl shadow-sheet text-[13px] outline-none animate-in zoom-in-95 fade-in duration-150"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <h2 id="ssh-import-title" className="text-[15px] font-semibold text-white">Import servers</h2>
          <button aria-label="Close" onClick={close} disabled={busy} className="icon-btn">
            <X size={14} />
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="seg" role="group" aria-label="Import from">
            <button type="button" className="seg-item" aria-pressed={source === "ssh"} onClick={() => switchSource("ssh")} disabled={busy}>
              ~/.ssh/config
            </button>
            <button type="button" className="seg-item" aria-pressed={source === "paste"} onClick={() => switchSource("paste")} disabled={busy}>
              PuTTY, MobaXterm or JSON
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-3 border-t border-white/[0.075] pt-3">
          {source === "paste" && hosts.length === 0 && !loading && (
            <div className="space-y-2.5">
              <div className="text-[12px] text-zinc-400 leading-relaxed">
                Paste an export from another SSH client:
                <ul className="mt-1.5 ml-4 list-disc space-y-1 text-zinc-500">
                  <li><span className="text-zinc-300">PuTTY</span>: export <code className="font-mono text-zinc-300">HKCU\Software\SimonTatham\PuTTY\Sessions</code> with regedit, then paste the .reg file.</li>
                  <li><span className="text-zinc-300">MobaXterm</span>: Export sessions, then paste the <code className="font-mono text-zinc-300">.mxtsessions</code> file.</li>
                  <li><span className="text-zinc-300">JSON</span>: an array of <code className="font-mono text-zinc-300">{`{name, host, port, user}`}</code>, or Termius-style <code className="font-mono text-zinc-300">{`{label, address, port, username}`}</code>.</li>
                </ul>
              </div>
              <textarea
                aria-label="Export to import"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={`[\n  {"name": "prod-web", "host": "1.2.3.4", "port": 22, "user": "root"}\n]`}
                rows={9}
                spellCheck={false}
                className="field h-auto py-2 font-mono text-[12px] leading-[18px] resize-none custom-scrollbar"
              />
              <div className="flex justify-end">
                <button type="button" onClick={() => parsePasted()} disabled={!pasteText.trim()} className="btn">
                  Read servers
                </button>
              </div>
            </div>
          )}

          {loading && (
            <div className="py-8 text-center text-zinc-400">
              {source === "ssh" ? "Reading ~/.ssh/config…" : "Reading the export…"}
            </div>
          )}

          {!loading && error && hosts.length === 0 && (
            <div role="alert" className="p-3 rounded-lg bg-red-500/10 text-red-400 text-[12px] whitespace-pre-wrap break-words">{error}</div>
          )}

          {!loading && !error && source === "ssh" && hosts.length === 0 && (
            <div className="py-8 text-center text-zinc-500">No servers to import in ~/.ssh/config.</div>
          )}

          {!loading && hosts.length > 0 && (
            <>
              <div className="sticky -top-3 z-10 -mx-4 px-4 py-2 mb-1 bg-elevated flex items-center justify-between">
                <button type="button" onClick={toggleAll} className="flex items-center gap-2 text-zinc-300 hover:text-white">
                  {selected.size === hosts.length ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-zinc-500" />}
                  <span>Select all ({hosts.length})</span>
                </button>
                <span className="text-[12px] text-zinc-500">{selected.size} selected</span>
              </div>
              <div className="space-y-1">
                {hosts.map((h) => {
                  const on = selected.has(h.host_alias);
                  return (
                    <label key={h.host_alias} className={`flex items-start gap-3 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${on ? "bg-primary/10" : "hover:bg-white/[0.05]"}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleOne(h.host_alias)} className="mt-0.5 accent-primary shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-white truncate">{h.host_alias}</span>
                        <span className="block text-[12px] font-mono text-zinc-400 truncate">{h.user ? `${h.user}@` : ""}{h.hostname}:{h.port}</span>
                        {(h.identity_file || h.proxy_jump) && (
                          <span className="block mt-0.5 text-[11.5px] text-zinc-500 truncate">
                            {h.identity_file && <span className="mr-2">Key {h.identity_file}</span>}
                            {h.proxy_jump && <span>Jump via {h.proxy_jump}</span>}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {error && <div role="alert" className="mt-3 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-[12px]">{error}</div>}
              {notice && <div role="status" className="mt-3 p-2.5 rounded-lg bg-amber-500/10 text-amber-300 text-[12px]">{notice}</div>}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/[0.075] flex items-center justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className="btn">Cancel</button>
          <button type="button" onClick={importSelected} disabled={busy || selected.size === 0 || loading} className="btn btn-primary">
            <Download size={13} />
            {busy ? "Importing…" : `Import ${selected.size}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
