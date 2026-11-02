import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check, ChevronLeft, ChevronRight, Copy, Download, Eye, EyeOff, KeyRound, LockKeyhole,
  MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2, Upload,
} from "lucide-react";
import { useConfirm, useTextPrompt } from "../ui/confirm";
import { fingerprint, parsePublicKey } from "../util/sshKeyInfo";

export interface VaultKey {
  id: number;
  name: string;
  public_key: string;
  has_private_key?: boolean;
  has_passphrase?: boolean;
}

export interface VaultCredential {
  id: number;
  name: string;
  auth_type: string;
  username: string;
  has_password?: boolean;
  key_id: number | null;
}

interface Props {
  credentials: VaultCredential[];
  sshKeys: VaultKey[];
  servers: any[];
  onNewPassword: () => void;
  onAddKey: () => void;
  onEditCredential: (c: VaultCredential) => void;
  onEditKey: (k: VaultKey) => void;
  onOpenServer: (server: any) => void;
  onChanged: (what: "keys" | "credentials") => void;
  addLog: (msg: string, kind?: string) => void;
}

type Filter = "all" | "key" | "pwd";
type KeyKind = "ed25519" | "rsa" | "ecdsa";

const KEY_KINDS: { value: KeyKind; label: string; hint: string }[] = [
  { value: "ed25519", label: "ED25519", hint: "Short, fast and accepted by any recent server." },
  { value: "rsa", label: "RSA 4096", hint: "For old servers that don't take ED25519. Takes a few seconds to make." },
  { value: "ecdsa", label: "ECDSA", hint: "NIST P-256, for servers or policies that ask for it." },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The servers that sign in with a login: a key directly or through a saved
// login that uses it, a saved login by its link.
function usage(servers: any[], credentials: VaultCredential[]) {
  const byKey = new Map<number, { server: any; via: string | null }[]>();
  const byCred = new Map<number, any[]>();
  const credsByKey = new Map<number, VaultCredential[]>();
  for (const c of credentials) {
    if (c.auth_type === "key" && c.key_id != null) {
      credsByKey.set(c.key_id, [...(credsByKey.get(c.key_id) ?? []), c]);
    }
  }
  const credById = new Map(credentials.map((c) => [c.id, c]));
  for (const s of servers) {
    if (s.auth_type === "custom_key" && s.key_id != null) {
      byKey.set(s.key_id, [...(byKey.get(s.key_id) ?? []), { server: s, via: null }]);
    } else if (s.auth_type === "vault" && s.credential_id != null) {
      byCred.set(s.credential_id, [...(byCred.get(s.credential_id) ?? []), s]);
      const c = credById.get(s.credential_id);
      if (c?.auth_type === "key" && c.key_id != null) {
        byKey.set(c.key_id, [...(byKey.get(c.key_id) ?? []), { server: s, via: c.name }]);
      }
    }
  }
  return { byKey, byCred, credsByKey };
}

function serverList(names: string[]) {
  if (names.length <= 3) return names.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export default function LoginsVault({
  credentials, sshKeys, servers, onNewPassword, onAddKey, onEditCredential, onEditKey, onOpenServer, onChanged, addLog,
}: Props) {
  const confirm = useConfirm();
  const textPrompt = useTextPrompt();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const { byKey, byCred, credsByKey } = useMemo(() => usage(servers, credentials), [servers, credentials]);

  const items = useMemo(() => {
    const keys = sshKeys.map((k) => {
      const info = parsePublicKey(k.public_key || "");
      const used = byKey.get(k.id) ?? [];
      return {
        id: `k:${k.id}`, kind: "key" as const, name: k.name, key: k, info,
        meta: `${info?.type ?? "Key"}, ${used.length ? `used by ${plural(used.length, "server", "servers")}` : "not used"}`,
        unused: used.length === 0 && !(credsByKey.get(k.id)?.length),
        search: `${k.name} ${info?.type ?? ""} ${info?.comment ?? ""}`,
      };
    });
    const creds = credentials.map((c) => {
      const used = byCred.get(c.id) ?? [];
      return {
        id: `p:${c.id}`, kind: "pwd" as const, name: c.name, cred: c,
        meta: `${c.username || "username asked"}, ${used.length ? plural(used.length, "server", "servers") : "not used"}`,
        unused: used.length === 0,
        search: `${c.name} ${c.username}`,
      };
    });
    return [...keys, ...creds].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [sshKeys, credentials, byKey, byCred, credsByKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((x) => (filter === "all" || x.kind === filter) && (!q || x.search.toLowerCase().includes(q)));
  }, [items, filter, query]);

  const cur = items.find((x) => x.id === sel) ?? visible[0] ?? null;

  useEffect(() => { setMenuOpen(false); }, [cur?.id]);

  const pick = (id: string) => { setSel(id); setDetailOpen(true); };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = visible.findIndex((x) => x.id === cur?.id);
    const next = visible[Math.max(0, Math.min(visible.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      setSel(next.id);
      document.getElementById(`login-${next.id}`)?.focus();
    }
  };

  const rename = async () => {
    if (!cur) return;
    const name = await textPrompt({
      title: cur.kind === "key" ? "Rename key" : "Rename login",
      initialValue: cur.name,
      okLabel: "Rename",
      validate: (v) => (v.trim() ? null : "Give it a name"),
    });
    if (!name || name.trim() === cur.name) return;
    try {
      if (cur.kind === "key") {
        const s = await invoke<{ private_key?: string | null; passphrase?: string | null }>("reveal_ssh_key", { id: cur.key.id });
        await invoke("edit_ssh_key", {
          id: cur.key.id, name: name.trim(), publicKey: cur.key.public_key,
          privateKey: s.private_key || "", passphrase: s.passphrase || null,
        });
        onChanged("keys");
      } else {
        const c = cur.cred;
        const password = c.has_password ? await invoke<string | null>("reveal_credential_password", { id: c.id }) : null;
        await invoke("edit_credential", {
          id: c.id, name: name.trim(), authType: c.auth_type, username: c.username,
          password: c.auth_type === "key" ? null : password, keyId: c.auth_type === "key" ? c.key_id : null,
        });
        onChanged("credentials");
      }
    } catch (e) {
      addLog(`Couldn't rename ${cur.name}: ${e}`, "error");
    }
  };

  const remove = async () => {
    if (!cur) return;
    setMenuOpen(false);
    if (cur.kind === "key") {
      const users = (byKey.get(cur.key.id) ?? []).map((u) => u.server.name);
      const logins = (credsByKey.get(cur.key.id) ?? []).map((c) => c.name);
      const parts = [
        users.length ? `${serverList(users)} sign in with it and will need another key or a password.` : "",
        logins.length ? `The saved ${logins.length === 1 ? "login" : "logins"} ${serverList(logins)} ${logins.length === 1 ? "uses" : "use"} it.` : "",
      ].filter(Boolean);
      const ok = await confirm({
        title: `Delete ${cur.name}?`,
        message: `${parts.join(" ")}${parts.length ? " " : ""}The private key can't be recovered unless you've exported it.`,
        okLabel: "Delete key",
        destructive: true,
      });
      if (!ok) return;
      try { await invoke("delete_ssh_key", { id: cur.key.id }); setSel(null); onChanged("keys"); }
      catch (e) { addLog(`Couldn't delete ${cur.name}: ${e}`, "error"); }
    } else {
      const users = (byCred.get(cur.cred.id) ?? []).map((s) => s.name);
      const ok = await confirm({
        title: `Delete ${cur.name}?`,
        message: users.length
          ? `${serverList(users)} sign in with it and will ask for a login when you connect.`
          : "No server uses it.",
        okLabel: "Delete login",
        destructive: true,
      });
      if (!ok) return;
      try { await invoke("delete_credential", { id: cur.cred.id }); setSel(null); onChanged("credentials"); }
      catch (e) { addLog(`Couldn't delete ${cur.name}: ${e}`, "error"); }
    }
  };

  const exportKey = async () => {
    if (cur?.kind !== "key") return;
    setMenuOpen(false);
    try {
      const path = await invoke<string | null>("export_ssh_key", { id: cur.key.id });
      if (path) addLog(`Saved ${cur.name} to ${path}, with its public key beside it as ${path}.pub.`, "success");
    } catch (e) {
      addLog(`Couldn't export ${cur.name}: ${e}`, "error");
    }
  };

  const empty = items.length === 0;

  return (
    <div className="flex flex-col h-full bg-surface relative">
      <header className="h-[52px] shrink-0 flex items-center gap-2 pl-4 pr-3 border-b border-white/[0.075]">
        <nav aria-label="Location" className="flex-1 min-w-0 flex items-center gap-0.5">
          {cur && detailOpen ? (
            <button type="button" onClick={() => setDetailOpen(false)} className="md:hidden icon-btn -ml-1.5" aria-label="Back to logins">
              <ChevronLeft size={16} aria-hidden />
            </button>
          ) : null}
          <span className={`h-6 flex items-center font-semibold text-white truncate ${cur ? "md:font-normal md:text-zinc-400" : ""}`}>Logins</span>
          {cur && (
            <>
              <ChevronRight size={13} aria-hidden className="hidden md:block shrink-0 text-zinc-500" />
              <span aria-current="page" className="hidden md:block px-1.5 font-semibold text-white truncate">{cur.name}</span>
            </>
          )}
        </nav>
        <button type="button" onClick={onNewPassword} className="btn" aria-label="New password">
          <Plus size={14} aria-hidden /><span className="hidden lg:inline">New password</span>
        </button>
        <button type="button" onClick={onAddKey} className="btn" aria-label="Add key file">
          <Upload size={14} aria-hidden /><span className="hidden lg:inline">Add key</span>
        </button>
        <div className="relative">
          <button type="button" onClick={() => setGenOpen((v) => !v)} aria-expanded={genOpen} aria-haspopup="dialog" className="btn btn-primary" aria-label="Generate key">
            <KeyRound size={14} aria-hidden /><span className="hidden sm:inline">Generate key</span>
          </button>
          {genOpen && (
            <GeneratePopover
              onClose={() => setGenOpen(false)}
              onDone={(id, name) => {
                setGenOpen(false);
                onChanged("keys");
                setSel(`k:${id}`);
                setDetailOpen(true);
                addLog(`Generated ${name}. Copy its public key to the servers that should accept it.`, "success");
              }}
              onError={(e) => addLog(`Couldn't generate the key: ${e}`, "error")}
            />
          )}
        </div>
      </header>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
          <span aria-hidden className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/[0.12] text-primary">
            <LockKeyhole size={22} />
          </span>
          <h1 className="mt-4 text-[17px] font-semibold text-white">No logins yet</h1>
          <p className="mt-1 max-w-[400px] text-zinc-400">
            Save a password or an SSH key once and pick it for any number of servers. Everything here is encrypted with your master password.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => setGenOpen(true)} className="btn btn-primary"><KeyRound size={14} aria-hidden /> Generate key</button>
            <button type="button" onClick={onAddKey} className="btn"><Upload size={14} aria-hidden /> Add a key file</button>
            <button type="button" onClick={onNewPassword} className="btn"><Plus size={14} aria-hidden /> New password</button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <section aria-label="Logins list" className={`${detailOpen ? "hidden md:flex" : "flex"} w-full md:w-[320px] md:shrink-0 flex-col md:border-r border-white/[0.075]`}>
            <div className="p-3 pb-2 space-y-2">
              <div role="group" aria-label="Show" className="seg w-full grid grid-cols-3">
                {([["all", "All"], ["key", "SSH keys"], ["pwd", "Passwords"]] as [Filter, string][]).map(([f, label]) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className="seg-item">{label}</button>
                ))}
              </div>
              <label className="relative block">
                <Search size={13} aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search logins"
                  aria-label="Search logins"
                  className="field pl-7"
                />
              </label>
            </div>
            <div role="list" onKeyDown={onListKey} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2">
              {visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-zinc-500">
                  {query ? `Nothing matches “${query.trim()}”.` : filter === "key" ? "No SSH keys yet." : "No saved passwords yet."}
                </p>
              ) : visible.map((x) => {
                const on = x.id === cur?.id;
                const Icon = x.kind === "key" ? KeyRound : LockKeyhole;
                return (
                  <div role="listitem" key={x.id}>
                    <button
                      id={`login-${x.id}`}
                      type="button"
                      onClick={() => pick(x.id)}
                      aria-current={on ? "true" : undefined}
                      className={`w-full flex items-center gap-2.5 h-12 px-2.5 rounded-lg text-left ${on ? "bg-primary/[0.14]" : "hover:bg-white/[0.05]"}`}
                    >
                      <span aria-hidden className={`w-7 h-7 shrink-0 rounded-md flex items-center justify-center ${on ? "bg-primary/[0.16] text-primary" : "bg-white/[0.06] text-zinc-400"}`}>
                        <Icon size={14} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-white truncate">{x.name}</span>
                        <span className="block text-[11.5px] leading-[15px] text-zinc-500 truncate">{x.meta}</span>
                      </span>
                      {x.unused && <span className="pill bg-white/[0.06] text-zinc-400">Unused</span>}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="shrink-0 flex items-center gap-1.5 px-4 h-9 border-t border-white/[0.075] text-[11.5px] text-zinc-500">
              <ShieldCheck size={13} aria-hidden /> Encrypted with your master password
            </div>
          </section>

          <section aria-label="Login details" className={`${detailOpen ? "flex" : "hidden md:flex"} flex-1 min-w-0 flex-col overflow-y-auto custom-scrollbar`}>
            {cur && (
              <div className="w-full max-w-[760px] px-4 pt-5 pb-10 sm:px-8 sm:pt-7">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="w-11 h-11 shrink-0 rounded-[10px] flex items-center justify-center bg-primary/[0.12] text-primary">
                    {cur.kind === "key" ? <KeyRound size={20} /> : <LockKeyhole size={20} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.01em] text-white break-words">{cur.name}</h1>
                    <p className="text-zinc-400">
                      {cur.kind === "key"
                        ? [cur.info?.type ?? "SSH key", cur.info?.bits ? `${cur.info.bits}-bit` : null, cur.info?.comment || null].filter(Boolean).join(", ")
                        : cur.cred.auth_type === "key" ? "Saved login with an SSH key" : "Saved password"}
                    </p>
                  </div>
                  <button type="button" onClick={rename} className="btn"><Pencil size={13} aria-hidden /> Rename</button>
                  <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMenuOpen(false); }}>
                    <button
                      type="button"
                      onClick={() => setMenuOpen((v) => !v)}
                      onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }}
                      aria-label={`More for ${cur.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      className="icon-btn"
                    >
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                    {menuOpen && (
                      <div role="menu" onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }} className="absolute right-0 top-full mt-1 z-30 min-w-[180px] p-1 rounded-lg bg-elevated shadow-pop">
                        <MenuItem icon={Pencil} label="Edit…" onClick={() => { setMenuOpen(false); cur.kind === "key" ? onEditKey(cur.key) : onEditCredential(cur.cred); }} />
                        {cur.kind === "key" && cur.key.has_private_key && <MenuItem icon={Download} label="Export…" onClick={exportKey} />}
                        <div className="my-1 h-px bg-white/[0.075]" />
                        <MenuItem icon={Trash2} label="Delete…" onClick={remove} danger />
                      </div>
                    )}
                  </div>
                </div>

                {cur.kind === "key"
                  ? <KeyDetails k={cur.key} info={cur.info} />
                  : <PasswordDetails c={cur.cred} keyName={sshKeys.find((k) => k.id === cur.cred.key_id)?.name ?? null} onShowKey={(id) => pick(`k:${id}`)} addLog={addLog} />}

                <UsedBy
                  rows={cur.kind === "key"
                    ? (byKey.get(cur.key.id) ?? [])
                    : (byCred.get(cur.cred.id) ?? []).map((s) => ({ server: s, via: null }))}
                  logins={cur.kind === "key" ? (credsByKey.get(cur.key.id) ?? []) : []}
                  onOpenServer={onOpenServer}
                  onShowLogin={(id) => pick(`p:${id}`)}
                />

                <div className="mt-6 flex flex-wrap gap-2">
                  {cur.kind === "key" && cur.key.has_private_key && (
                    <button type="button" onClick={exportKey} className="btn"><Download size={13} aria-hidden /> Export</button>
                  )}
                  <button type="button" onClick={remove} className="btn text-danger"><Trash2 size={13} aria-hidden /> Delete</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger = false }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-2 h-7 px-2 rounded-md text-left ${danger ? "text-danger hover:bg-danger/10" : "text-white hover:bg-white/[0.09]"}`}
    >
      <Icon size={13} aria-hidden /> {label}
    </button>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] divide-y divide-white/[0.075]">{children}</div>;
}

function Row({ label, children, top = false }: { label: string; children: React.ReactNode; top?: boolean }) {
  return (
    <div className={`grid gap-1 sm:gap-4 sm:grid-cols-[130px_minmax(0,1fr)] px-3.5 py-2.5 min-h-[44px] ${top ? "sm:items-start" : "sm:items-center"}`}>
      <span className="text-zinc-400">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CopyButton({ value, label = "Copy" }: { value: string | (() => Promise<string | null>); label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const text = typeof value === "string" ? value : await value();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" onClick={copy} className="btn btn-sm">
      {done ? <Check size={12} aria-hidden className="text-success" /> : <Copy size={12} aria-hidden />}
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

function KeyDetails({ k, info }: { k: VaultKey; info: ReturnType<typeof parsePublicKey> }) {
  const [fp, setFp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFp(null);
    fingerprint(info).then((v) => { if (live) setFp(v); });
    return () => { live = false; };
  }, [info]);

  return (
    <div className="mt-6">
      <Group>
        <Row label="Fingerprint">
          <span className="font-mono text-[12px] text-white break-all select-text">{fp ?? (info ? "…" : "No public key saved")}</span>
        </Row>
        <Row label="Private key">
          <span className="flex items-center gap-1.5 text-white">
            {k.has_private_key
              ? <><LockKeyhole size={13} aria-hidden className="text-success shrink-0" /> Encrypted in the vault</>
              : <span className="text-zinc-400">Not saved: this entry holds only the public key</span>}
          </span>
        </Row>
        {k.has_private_key && (
          <Row label="Passphrase">
            <span className={k.has_passphrase ? "text-white" : "text-zinc-400"}>
              {k.has_passphrase ? "Saved with the key" : "None saved"}
            </span>
          </Row>
        )}
        <Row label="Public key" top>
          {k.public_key ? (
            <>
              <div className="font-mono text-[12px] leading-[18px] text-white break-all select-text line-clamp-3">{k.public_key}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <CopyButton value={k.public_key} />
              </div>
              <p className="mt-1.5 text-[11.5px] leading-[15px] text-zinc-500">
                Add it to <span className="font-mono">~/.ssh/authorized_keys</span> on a server to sign in there with this key.
              </p>
            </>
          ) : <span className="text-zinc-400">None saved</span>}
        </Row>
      </Group>
    </div>
  );
}

function PasswordDetails({ c, keyName, onShowKey, addLog }: {
  c: VaultCredential; keyName: string | null; onShowKey: (id: number) => void; addLog: Props["addLog"];
}) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { setShown(null); }, [c.id]);
  const reveal = async () => {
    try { return (await invoke<string | null>("reveal_credential_password", { id: c.id })) ?? ""; }
    catch (e) { addLog(`Couldn't read the password: ${e}`, "error"); return null; }
  };
  return (
    <div className="mt-6">
      <Group>
        <Row label="Username">
          {c.username
            ? <span className="font-mono text-[12px] text-white select-text">{c.username}</span>
            : <span className="text-zinc-400">Asked when connecting</span>}
        </Row>
        {c.auth_type === "key" ? (
          <Row label="SSH key">
            {c.key_id != null && keyName
              ? <button type="button" onClick={() => onShowKey(c.key_id!)} className="inline-flex items-center gap-1.5 text-primary hover:underline"><KeyRound size={13} aria-hidden /> {keyName}</button>
              : <span className="text-danger">The key it used is gone. Pick another under Edit.</span>}
          </Row>
        ) : (
          <Row label="Password">
            {c.has_password ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12px] text-white mr-1.5 break-all select-text">{shown ?? "••••••••••••"}</span>
                <button
                  type="button"
                  aria-pressed={shown !== null}
                  onClick={async () => { if (shown !== null) setShown(null); else { const v = await reveal(); if (v !== null) setShown(v); } }}
                  className="btn btn-sm"
                >
                  {shown !== null ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
                  {shown !== null ? "Hide" : "Reveal"}
                </button>
                <CopyButton value={reveal} />
              </div>
            ) : <span className="text-zinc-400">Not saved: asked when connecting</span>}
          </Row>
        )}
      </Group>
    </div>
  );
}

function UsedBy({ rows, logins, onOpenServer, onShowLogin }: {
  rows: { server: any; via: string | null }[];
  logins: VaultCredential[];
  onOpenServer: (s: any) => void;
  onShowLogin: (id: number) => void;
}) {
  return (
    <>
      <h2 className="mt-7 mb-2 text-[13px] font-semibold text-white">
        {rows.length ? `Used by ${plural(rows.length, "server", "servers")}` : "Used by"}
      </h2>
      {rows.length ? (
        <Group>
          {rows.map(({ server: s, via }) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpenServer(s)}
              className="group w-full flex items-center gap-2.5 h-10 px-3.5 text-left hover:bg-white/[0.04] first:rounded-t-[10px] last:rounded-b-[10px]"
            >
              <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color || "rgb(var(--subtle))" }} />
              <span className="font-medium text-white truncate">{s.name}</span>
              <span className="font-mono text-[12px] text-zinc-500 truncate">{s.host}</span>
              {via && <span className="hidden sm:inline text-[11.5px] text-zinc-500 truncate">through {via}</span>}
              <span className="ml-auto text-[11.5px] font-medium text-zinc-500 group-hover:text-white group-focus-visible:text-white">Connect</span>
            </button>
          ))}
        </Group>
      ) : (
        <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] px-3.5 py-3 text-zinc-400">
          No server uses it yet. Pick it under Authentication when you edit a server.
        </div>
      )}
      {logins.length > 0 && (
        <p className="mt-2 text-[12px] text-zinc-500">
          Saved {logins.length === 1 ? "login" : "logins"} with this key:{" "}
          {logins.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <button type="button" onClick={() => onShowLogin(c.id)} className="text-primary hover:underline">{c.name}</button>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function GeneratePopover({ onClose, onDone, onError }: {
  onClose: () => void;
  onDone: (id: number, name: string) => void;
  onError: (e: unknown) => void;
}) {
  const [kind, setKind] = useState<KeyKind>("ed25519");
  const [name, setName] = useState(`${kind}-${new Date().getFullYear()}`);
  const [nameTouched, setNameTouched] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { if (!nameTouched) setName(`${kind}-${new Date().getFullYear()}`); }, [kind, nameTouched]);
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (busy || !ref.current || ref.current.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[aria-haspopup=dialog]")) return;
      onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [busy, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const key = await invoke<{ id: number }>("generate_ssh_key", { name: name.trim(), kind, comment: comment.trim() || null });
      onDone(key.id, name.trim());
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  return (
    <form
      ref={ref}
      role="dialog"
      aria-label="Generate SSH key"
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } }}
      className="absolute right-0 top-full mt-2 z-40 w-[min(340px,calc(100vw-24px))] p-4 rounded-xl bg-elevated shadow-pop animate-in"
    >
      <div className="font-semibold text-white">Generate SSH key</div>
      <p className="mt-0.5 text-[12px] text-zinc-400">The private key is made here and kept in the vault.</p>
      <div className="mt-3.5 space-y-3">
        <div>
          <div className="mb-1 text-[12px] text-zinc-400">Type</div>
          <div role="group" aria-label="Key type" className="seg w-full grid grid-cols-3">
            {KEY_KINDS.map((k) => (
              <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)} className="seg-item">{k.label}</button>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] leading-[15px] text-zinc-500">{KEY_KINDS.find((k) => k.value === kind)!.hint}</p>
        </div>
        <label className="block">
          <span className="block mb-1 text-[12px] text-zinc-400">Name</span>
          <input className="field" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} required />
        </label>
        <label className="block">
          <span className="block mb-1 text-[12px] text-zinc-400">Comment</span>
          <input className="field font-mono text-[12px]" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="you@this-computer" />
          <span className="block mt-1 text-[11.5px] leading-[15px] text-zinc-500">Ends the public key, so a server's authorized_keys says whose it is.</span>
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">{busy ? "Generating…" : "Generate"}</button>
      </div>
    </form>
  );
}
