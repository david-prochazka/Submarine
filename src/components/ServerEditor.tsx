import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight, Cable, Copy, Download, FlaskConical, FolderOpen, FolderPlus, History, KeyRound, Monitor, Network, Play, Plus,
  Rocket, Server, ShieldAlert, Square, Tags, Trash2, X,
} from "lucide-react";
import PasswordField from "./PasswordField";
import ServerImportDialog, { type NumberedImportRequest } from "./ServerImportDialog";
import { useTextPrompt } from "../ui/confirm";
import { useSlideOverFocus } from "../ui/slideOverFocus";
import { folderTree } from "../util/folderTree";
import { DEFAULT_RDP_OPTIONS, RDP_BUILTIN_EXPERIMENTAL, RDP_WINDOW_SIZES, type RdpOptions } from "../util/rdpOptions";
import { SwitchRow } from "./FormRows";
import { RdpShareFields, RdpSpeedFields } from "./RdpOptionFields";
import { VncSpeedFields } from "./VncOptionFields";
import { DEFAULT_VNC_OPTIONS, normalizeVncOptions, type VncOptions } from "../util/vncOptions";
import { IS_ANDROID, IS_MAC, IS_WINDOWS } from "../util/platform";
import { TAG_COLOURS, customTagColour, pickerValue } from "../util/tagColours";
import { joinTarget, serverIssues, splitTarget, type EditorSection, type Issue } from "../util/serverIssues";

// "2h ago" for the last-edited line.
function relTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const dd = Math.floor(h / 24); if (dd < 30) return `${dd} d ago`;
  return d.toLocaleDateString();
}

// An HLC stamp is "{phys_ms}:{counter}:{node_id}": the wall-clock millisecond
// the row was last written comes first.
function hlcTime(stamp?: string | null): Date | null {
  if (!stamp) return null;
  const ms = parseInt(String(stamp).split(":")[0], 10);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

const errText = (e: any) => (typeof e === "string" ? e : e?.message || String(e));

type Protocol = "ssh" | "rdp" | "telnet" | "vnc";
const USUAL_PORT: Record<Protocol, number> = { ssh: 22, rdp: 3389, telnet: 23, vnc: 5900 };
const PROTOCOL_LABEL: Record<Protocol, string> = { ssh: "SSH", rdp: "RDP", vnc: "VNC", telnet: "Telnet" };

const SECTION_META: Record<EditorSection, { label: string; icon: typeof Server }> = {
  connection: { label: "Connection", icon: Server },
  auth: { label: "Authentication", icon: KeyRound },
  org: { label: "Organisation", icon: Tags },
  proxy: { label: "Proxy", icon: Network },
  forward: { label: "Port forwarding", icon: Cable },
  mirrors: { label: "Mirrors", icon: FolderOpen },
  startup: { label: "Startup", icon: Rocket },
  display: { label: "Display", icon: Monitor },
};

const sectionsFor = (p: Protocol): EditorSection[] =>
  p === "ssh" ? ["connection", "auth", "org", "proxy", "forward", "mirrors", "startup"]
    : p === "telnet" ? ["connection", "auth", "org", "proxy"]
      : ["connection", "auth", "org", "proxy", "display"];

type ProbeResult = {
  target: string | null;
  addresses: string[];
  connect_ms: number | null;
  host_key: { key_type: string; fingerprint: string; trust: string; note: string | null } | null;
  failed: string | null;
  error: string | null;
};
type TestState = { kind: "idle" } | { kind: "running"; label: string } | { kind: "blocked" } | { kind: "done"; label: string; via: string | null; result: ProbeResult };

function Group({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] divide-y divide-white/[0.075] ${className}`}>{children}</div>;
}

// A label and its control; under 640 px wide, one above the other.
function Row({ label, htmlFor, children, top = false }: { label: ReactNode; htmlFor?: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={`grid gap-1.5 sm:gap-4 sm:grid-cols-[150px_minmax(0,1fr)] px-3.5 py-2 min-h-[44px] ${top ? "sm:items-start" : "sm:items-center"}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={`text-white ${top ? "sm:pt-1" : ""}`}>{label}</label>
      ) : (
        <span className={`text-white ${top ? "sm:pt-1" : ""}`}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Hint({ tone = "plain", id, children }: { tone?: "plain" | "err" | "ok" | "warn"; id?: string; children: ReactNode }) {
  const colour = tone === "err" ? "text-danger" : tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-zinc-500";
  return <div id={id} className={`mt-1 text-[11.5px] leading-[15px] ${colour}`}>{children}</div>;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${checked ? "bg-primary" : "bg-white/[0.08]"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${checked ? "translate-x-[14px]" : ""}`} />
    </button>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg flex-wrap" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="seg-item" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const fieldCls = (err: boolean, extra = "") =>
  `field ${extra} ${err ? "border-danger focus:border-danger ring-[3px] ring-danger/20 focus:ring-danger/30" : ""}`;

const ServerEditor = ({ isOpen, onClose, newNode, setNewNode, onSave, credentials, sshKeys, refreshSshKeys, folders, refreshFolders, refreshServers, servers, isEditMode, formError, importRequest }: {
  isOpen: boolean;
  onClose: () => void;
  newNode: any;
  setNewNode: (n: any) => void;
  onSave: () => unknown;
  credentials?: any[];
  sshKeys?: any[];
  refreshSshKeys?: () => unknown;
  folders?: any[];
  refreshFolders: () => unknown;
  refreshServers?: () => unknown;
  servers?: any[];
  isEditMode: boolean;
  formError?: string;
  isMobile?: boolean;
  importRequest?: NumberedImportRequest | null;
}) => {
  const protocol: Protocol = (["rdp", "telnet", "vnc"] as const).includes(newNode.protocol) ? newNode.protocol : "ssh";
  const isSsh = protocol === "ssh";
  const isRdp = protocol === "rdp";
  const isVnc = protocol === "vnc";
  const isTelnet = protocol === "telnet";
  const set = (patch: Record<string, unknown>) => setNewNode({ ...newNode, ...patch });

  const sections = sectionsFor(protocol);
  const [section, setSection] = useState<EditorSection>("connection");
  const shownSection = sections.includes(section) ? section : "connection";
  // Which fields show their issue: one left (blurred), or every one after a
  // save or test was tried.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [resolved, setResolved] = useState<{ host: string; text: string; ok: boolean } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  // A key generated here: its public half shows while it's the one picked,
  // since it has to go into the server's authorized_keys first.
  const [generatedKey, setGeneratedKey] = useState<{ id: number; name: string; publicKey: string } | null>(null);
  const [publicKeyCopied, setPublicKeyCopied] = useState(false);
  const textPrompt = useTextPrompt();
  const sheetRef = useSlideOverFocus(isOpen);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // The sheet stays mounted to animate out: what one server left behind
  // mustn't greet the next.
  useEffect(() => {
    if (isOpen) return;
    setSection("connection");
    setTouched(new Set());
    setShowAll(false);
    setTest({ kind: "idle" });
    setResolved(null);
    setNewFolder(null);
    setKeyNote(null);
    setGeneratedKey(null);
  }, [isOpen]);

  // This computer's drives, for sharing a whole one with an RDP server.
  const [localDrives, setLocalDrives] = useState<string[]>([]);
  useEffect(() => {
    if (isOpen && isRdp && IS_WINDOWS) invoke<string[]>("rdp_share_drives").then(setLocalDrives, () => setLocalDrives([]));
  }, [isOpen, isRdp]);

  const issues = useMemo(() => serverIssues(newNode), [newNode]);
  const visible = (i: Issue) => showAll || touched.has(i.field);
  const issueFor = (field: string) => issues.find((i) => i.field === field && visible(i));
  const touch = (field: string) => () => setTouched((t) => (t.has(field) ? t : new Set(t).add(field)));
  const sectionIssues = (s: EditorSection) => issues.filter((i) => i.section === s && visible(i)).length;

  // A finished test no longer says anything once what it tested changes.
  const route = `${protocol}|${newNode.host}|${newNode.port}|${newNode.proxyType}|${newNode.proxyHost}|${newNode.proxyPort}|${newNode.jumpHostId}`;
  useEffect(() => {
    setTest((t) => (t.kind === "running" ? t : { kind: "idle" }));
  }, [route]);

  // Where the name points, under the Host field, once typing stops. Not when
  // a proxy or jump host looks it up instead.
  const host = String(newNode.host ?? "").trim();
  const viaOther = (isSsh && (newNode.proxyType === "socks5" || newNode.proxyType === "http")) || !!newNode.jumpHostId;
  useEffect(() => {
    if (!isOpen || !host || /\s/.test(host) || viaOther) {
      setResolved(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      invoke<string[]>("resolve_host", { host, port: Number(newNode.port) || USUAL_PORT[protocol] })
        .then((addrs) => {
          if (!live) return;
          if (!addrs.length) setResolved(null);
          else if (addrs.length === 1 && addrs[0] === host) setResolved(null);
          else setResolved({ host, ok: true, text: `Resolves to ${addrs.slice(0, 2).join(", ")}${addrs.length > 2 ? ` and ${addrs.length - 2} more` : ""}` });
        })
        .catch((e) => live && setResolved({ host, ok: false, text: errText(e) }));
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, host, viaOther, protocol]);

  const setProtocol = (next: Protocol) => {
    if (next === protocol) return;
    // The new kind's usual port, unless another was typed.
    const port = !newNode.port || Object.values(USUAL_PORT).includes(Number(newNode.port)) ? USUAL_PORT[next] : newNode.port;
    const authType = next !== "ssh" && newNode.authType === "custom_key" ? "custom_pass" : newNode.authType;
    set({ protocol: next, port, authType });
  };

  const focusField = (field: string) => {
    requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`);
      el?.focus({ preventScroll: false });
    });
  };

  const save = () => {
    if (issues.length > 0) {
      setShowAll(true);
      const first = issues[0];
      setSection(first.section);
      focusField(first.field);
      return;
    }
    onSave();
  };

  const jumpHost = (servers ?? []).find((s: any) => String(s.id) === String(newNode.jumpHostId));

  const runTest = async () => {
    if (test.kind === "running") return;
    const blocking = issues.filter((i) => i.section === "connection" || i.section === "proxy");
    if (blocking.length > 0) {
      setShowAll(true);
      setSection(blocking[0].section);
      focusField(blocking[0].field);
      setTest({ kind: "blocked" });
      return;
    }
    // Through a jump host the test can't go further than the jump host
    // itself, so that's what it tests.
    const via = jumpHost ? jumpHost.name : null;
    const target = jumpHost
      ? { host: jumpHost.host, port: jumpHost.port, protocol: "ssh", proxyType: jumpHost.proxy_type || "none", proxyHost: jumpHost.proxy_host || "", proxyPort: jumpHost.proxy_port || 1080 }
      : { host, port: Number(newNode.port), protocol, proxyType: isSsh ? newNode.proxyType || "none" : "none", proxyHost: newNode.proxyHost || "", proxyPort: Number(newNode.proxyPort) || 1080 };
    const label = `${target.host}:${target.port}`;
    setTest({ kind: "running", label });
    try {
      const result = await invoke<ProbeResult>("test_server_connection", target);
      setTest({ kind: "done", label, via, result });
    } catch (e) {
      setTest({ kind: "done", label, via, result: { target: null, addresses: [], connect_ms: null, host_key: null, failed: "port", error: errText(e) } });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };

  // Browse to a key on disk and pick it here in one step. It goes into the
  // vault (deduped by content), which is what syncs, so the server keeps
  // working on a machine where ~/.ssh looks different.
  const browseForKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyNote(null);
    try {
      const path = await invoke<string | null>("pick_ssh_key_file");
      if (!path) return;
      const key = await invoke<{ id: number; name: string; reused: boolean; encrypted: boolean }>("import_ssh_key_file", { path, name: null });
      await refreshSshKeys?.();
      set({ keyId: key.id.toString() });
      setKeyNote(
        key.encrypted
          ? `Loaded "${key.name}". It has a passphrase: add it under Logins, or leave it to be asked when connecting.`
          : key.reused
            ? `"${key.name}" was already in your vault, so that one is picked.`
            : `Loaded "${key.name}" into your vault.`,
      );
    } catch (e) {
      setKeyNote(errText(e));
    } finally {
      setKeyBusy(false);
    }
  };

  // A new Ed25519 key without leaving the form (#23), picked straight away.
  const generateKey = async () => {
    if (keyBusy) return;
    const name = await textPrompt({
      title: "Generate SSH key",
      message: "Name the key. The name is only for you, here in Submarine.",
      initialValue: `${String(newNode.name || newNode.host || "server").trim()}-key`,
      okLabel: "Generate",
      validate: (v) => (v.length === 0 ? "Give the key a name." : null),
    });
    if (!name) return;
    setKeyBusy(true);
    setKeyNote(null);
    setGeneratedKey(null);
    try {
      const key = await invoke<{ id: number; public_key: string }>("generate_ssh_key", { name });
      await refreshSshKeys?.();
      set({ keyId: key.id.toString() });
      setGeneratedKey({ id: key.id, name, publicKey: key.public_key });
      setPublicKeyCopied(false);
    } catch (e) {
      setKeyNote(errText(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const copyPublicKey = async () => {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey.publicKey);
      setPublicKeyCopied(true);
    } catch {
      setKeyNote("Couldn't copy. Select the key text and copy it by hand.");
    }
  };

  const createFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name) return;
    try {
      await invoke("add_folder", { name, parentId: null });
      await refreshFolders();
      const all = await invoke<any[]>("get_folders").catch(() => []);
      const made = all.filter((f) => f.name === name && f.parent_id == null).sort((a, b) => b.id - a.id)[0];
      setNewFolder(null);
      if (made) set({ folderId: String(made.id) });
    } catch (e) {
      setKeyNote(null);
      console.error(e);
    }
  };

  const tunnels: any[] = newNode.tunnels ?? [];
  const setTunnel = (idx: number, patch: Record<string, unknown>) =>
    set({ tunnels: tunnels.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
  const mirrors: any[] = newNode.mirrors ?? [];
  const setMirror = (idx: number, patch: Record<string, unknown>) =>
    set({ mirrors: mirrors.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });

  const folderLabel = (() => {
    if (!newNode.folderId) return "No folder";
    return folderTree(folders ?? []).label(Number(newNode.folderId)) || "No folder";
  })();
  const edited = hlcTime(newNode.updatedAt);
  const subtitle = [
    folderLabel,
    isEditMode && (edited || newNode.editedBy)
      ? `last edited${edited ? ` ${relTime(edited)}` : ""}${newNode.editedBy ? ` by ${newNode.editedBy}` : ""}`
      : null,
  ].filter(Boolean).join(", ");

  const tag = newNode.color ?? null;

  // ---- Sections -------------------------------------------------------------

  const connection = (
    <>
      <Group>
        <Row label="Name" htmlFor="srv-name">
          <input
            id="srv-name" data-field="name" type="text" value={newNode.name ?? ""} placeholder="web-prod-01"
            onChange={(e) => set({ name: e.target.value })} onBlur={touch("name")}
            aria-invalid={!!issueFor("name")} aria-describedby={issueFor("name") ? "srv-name-hint" : undefined}
            className={fieldCls(!!issueFor("name"))}
          />
          {issueFor("name") && <Hint tone="err" id="srv-name-hint">{issueFor("name")!.message}</Hint>}
        </Row>
        <Row label="Protocol">
          <Seg label="Protocol" value={protocol} onChange={setProtocol} options={(["ssh", "rdp", "vnc", "telnet"] as Protocol[]).map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))} />
          {isTelnet && (
            <Hint tone="warn">
              Telnet isn't encrypted: what you type, passwords too, crosses the network as plain text. Use it on a network you trust, or through an SSH server (Proxy).
            </Hint>
          )}
          {isVnc && !newNode.jumpHostId && (
            <Hint tone="warn">VNC isn't encrypted. Go through an SSH server (Proxy) to keep it private up to that server.</Hint>
          )}
        </Row>
        <Row label="Host" htmlFor="srv-host">
          <input
            id="srv-host" data-field="host" type="text" value={newNode.host ?? ""} placeholder="10.0.4.21 or web.example.com"
            onChange={(e) => set({ host: e.target.value })} onBlur={touch("host")}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            aria-invalid={!!issueFor("host")} aria-describedby="srv-host-hint"
            className={fieldCls(!!issueFor("host"), "font-mono")}
          />
          {issueFor("host") ? (
            <Hint tone="err" id="srv-host-hint">{issueFor("host")!.message}</Hint>
          ) : resolved && resolved.host === host ? (
            <Hint tone={resolved.ok ? "ok" : "warn"} id="srv-host-hint">{resolved.text}</Hint>
          ) : null}
        </Row>
        <Row label="Port" htmlFor="srv-port">
          <input
            id="srv-port" data-field="port" type="text" inputMode="numeric" value={newNode.port ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              set({ port: /^\d+$/.test(v) ? Number(v) : v });
            }}
            onBlur={touch("port")}
            aria-invalid={!!issueFor("port")} aria-describedby="srv-port-hint"
            className={fieldCls(!!issueFor("port"), "font-mono w-28")}
          />
          {issueFor("port") ? (
            <Hint tone="err" id="srv-port-hint">{issueFor("port")!.message}</Hint>
          ) : Number(newNode.port) !== USUAL_PORT[protocol] ? (
            <Hint id="srv-port-hint">{PROTOCOL_LABEL[protocol]} usually listens on {USUAL_PORT[protocol]}.</Hint>
          ) : null}
        </Row>
      </Group>
    </>
  );

  const selectedCred = credentials?.find((c: any) => c.id?.toString() === newNode.credentialId?.toString());
  const keyUsers = newNode.keyId
    ? (servers ?? []).filter((s: any) => s.id !== newNode.id && String(s.key_id ?? "") === String(newNode.keyId) && s.auth_type === "custom_key").length
    : 0;
  const usernameRow = (placeholder: string, hint?: string) => (
    <Row label="Username" htmlFor="srv-user">
      <input
        id="srv-user" type="text" value={newNode.username ?? ""} placeholder={placeholder}
        onChange={(e) => set({ username: e.target.value })}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        className="field font-mono"
      />
      {hint && <Hint>{hint}</Hint>}
    </Row>
  );

  const auth = (
    <Group>
      <Row label="Method">
        <Seg
          label="How to log in"
          value={newNode.authType ?? "custom_pass"}
          onChange={(authType) => set({ authType })}
          options={[
            { value: "custom_pass", label: "Password" },
            ...(isSsh ? [{ value: "custom_key", label: "SSH key" }] : []),
            { value: "vault", label: "Saved login" },
          ]}
        />
      </Row>

      {newNode.authType === "vault" && (
        <Row label="Saved login" htmlFor="srv-cred">
          <select
            id="srv-cred" data-field="credentialId" value={newNode.credentialId ?? ""}
            onChange={(e) => { set({ credentialId: e.target.value }); touch("credentialId")(); }}
            aria-invalid={!!issueFor("credentialId")}
            className={fieldCls(!!issueFor("credentialId"))}
          >
            <option value="">Pick a login</option>
            {credentials?.map((c: any) => <option key={c.id} value={c.id.toString()}>{c.name}{c.username ? ` (${c.username})` : ""}</option>)}
          </select>
          {issueFor("credentialId") ? (
            <Hint tone="err">{issueFor("credentialId")!.message}</Hint>
          ) : selectedCred ? (
            <Hint>Logs in as <span className="font-mono text-zinc-300">{selectedCred.username || "the user asked for"}</span> with {selectedCred.auth_type === "key" ? "a key" : "a password"}, from your Logins.</Hint>
          ) : (credentials?.length ?? 0) === 0 ? (
            <Hint>No saved logins yet. Add one under Logins in the sidebar.</Hint>
          ) : null}
        </Row>
      )}

      {newNode.authType === "custom_pass" && isRdp && (<>
        {usernameRow("Asked by the RDP app", "DOMAIN\\user works too.")}
        <Row label="Password" htmlFor="srv-pass">
          <PasswordField
            id="srv-pass" value={newNode.password || ""}
            onChange={(v) => set({ password: v, password_dirty: true })}
            className="field" placeholder="Ask when connecting"
          />
          <Hint>Leave it empty to be asked when connecting. Remote Desktop Connection on Windows gets it too.</Hint>
        </Row>
      </>)}

      {newNode.authType === "custom_pass" && !isRdp && (<>
        {!isVnc && usernameRow(isTelnet ? "For your reference" : "Ask when connecting")}
        <Row label={isVnc ? "VNC password" : "Password"} htmlFor="srv-pass">
          <PasswordField
            id="srv-pass" value={newNode.password || ""}
            onChange={(v) => set({ password: v, password_dirty: true })}
            className="field" placeholder="Ask when connecting"
          />
          <Hint>
            {isTelnet
              ? "A telnet server asks for the login in the terminal. Type it there; at the password prompt, the terminal's key button types this one."
              : isVnc
                ? "Leave it empty to be asked when the server wants one. VNC uses its first 8 characters."
                : "Leave it empty to be asked when connecting."}
          </Hint>
        </Row>
      </>)}

      {newNode.authType === "custom_key" && isSsh && (<>
        {usernameRow("Ask when connecting")}
        <Row label="Key" htmlFor="srv-key" top>
          <select
            id="srv-key" data-field="keyId" value={newNode.keyId ?? ""}
            onChange={(e) => { set({ keyId: e.target.value }); touch("keyId")(); }}
            aria-invalid={!!issueFor("keyId")}
            className={fieldCls(!!issueFor("keyId"))}
          >
            <option value="">Pick a key</option>
            {sshKeys?.map((k: any) => <option key={k.id} value={k.id.toString()}>{k.name}</option>)}
          </select>
          {issueFor("keyId") ? (
            <Hint tone="err">{issueFor("keyId")!.message}</Hint>
          ) : newNode.keyId && !generatedKey ? (
            <Hint>From your Logins vault.{keyUsers > 0 ? ` Also used by ${keyUsers} other server${keyUsers === 1 ? "" : "s"}.` : ""}</Hint>
          ) : null}
          {keyNote && <Hint>{keyNote}</Hint>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" onClick={generateKey} disabled={keyBusy} className="btn btn-sm" title="Make a new key and use it for this server">
              <Plus size={12} /> Generate key
            </button>
            <button type="button" onClick={browseForKey} disabled={keyBusy} className="btn btn-sm">
              <KeyRound size={12} /> {keyBusy ? "Loading…" : "Load from file"}
            </button>
          </div>
          {generatedKey && newNode.keyId === generatedKey.id.toString() && (
            <div className="mt-2 p-2.5 rounded-lg bg-white/[0.04] text-[12px] text-zinc-400 space-y-2">
              <div>
                Generated "{generatedKey.name}". Add its public key to <code className="font-mono text-zinc-300">~/.ssh/authorized_keys</code> on the server before connecting:
              </div>
              <code className="block p-2 rounded-md bg-field font-mono text-[11.5px] text-zinc-300 break-all select-text">{generatedKey.publicKey}</code>
              <button type="button" onClick={copyPublicKey} className="btn btn-sm">
                <Copy size={12} /> {publicKeyCopied ? "Copied" : "Copy public key"}
              </button>
            </div>
          )}
        </Row>
      </>)}
    </Group>
  );

  const org = (
    <Group>
      <Row label="Folder" htmlFor="srv-folder">
        {newFolder === null ? (
          <div className="flex gap-2">
            <select id="srv-folder" value={newNode.folderId ?? ""} onChange={(e) => set({ folderId: e.target.value })} className="field flex-1 w-auto min-w-0">
              <option value="">No folder</option>
              {(() => {
                const tree = folderTree(folders ?? []);
                return (folders ?? [])
                  .map((f: any) => ({ id: f.id, label: tree.label(f.id) }))
                  .sort((a: any, b: any) => a.label.localeCompare(b.label))
                  .map((f: any) => <option key={f.id} value={f.id.toString()}>{f.label}</option>);
              })()}
            </select>
            <button type="button" aria-label="New folder" title="New folder" onClick={() => setNewFolder("")} className="btn px-2">
              <FolderPlus size={14} />
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text" autoFocus aria-label="New folder name" placeholder="Folder name" value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") { e.stopPropagation(); setNewFolder(null); }
              }}
              className="field flex-1 min-w-0"
            />
            <button type="button" onClick={createFolder} disabled={!newFolder.trim()} className="btn btn-primary">Add</button>
            <button type="button" aria-label="Cancel" onClick={() => setNewFolder(null)} className="btn px-2"><X size={14} /></button>
          </div>
        )}
      </Row>
      <Row label="Tag">
        <div className="flex items-center gap-2 flex-wrap py-1">
          {TAG_COLOURS.map((p) => {
            const on = tag === p.value;
            return (
              <button
                key={p.name}
                type="button"
                title={p.name}
                aria-label={p.name}
                aria-pressed={on}
                onClick={() => set({ color: p.value })}
                className={`w-4 h-4 rounded-full transition-shadow ${p.value ? "" : "bg-zinc-600"} ${on ? "shadow-[0_0_0_2px_rgb(var(--panel)),0_0_0_3.5px_rgb(var(--ink))]" : "hover:shadow-[0_0_0_2px_rgb(var(--panel)),0_0_0_3.5px_var(--border-strong)]"}`}
                style={p.value ? { background: p.value } : undefined}
              />
            );
          })}
          {(() => {
            const custom = customTagColour(tag);
            return (
              <label
                title="Another colour…"
                className={`relative w-4 h-4 rounded-full cursor-pointer ${custom ? "shadow-[0_0_0_2px_rgb(var(--panel)),0_0_0_3.5px_rgb(var(--ink))]" : ""}`}
                style={{ background: custom ?? "conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)" }}
              >
                <input
                  type="color" aria-label="Another colour" value={pickerValue(tag)}
                  onChange={(e) => set({ color: e.target.value })}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </label>
            );
          })()}
          <span className="ml-1 text-[12px] text-zinc-500">{TAG_COLOURS.find((c) => c.value === tag)?.name ?? "Custom"}</span>
        </div>
      </Row>
      <Row label="Notes" htmlFor="srv-notes" top>
        <textarea
          id="srv-notes" rows={5} value={newNode.notes || ""}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder={"Prod web. Reboots Sun 04:00 UTC.\nDeploy with `make ship`."}
          className="field h-auto py-2 leading-[18px] resize-y"
        />
        <Hint>A runbook, contacts, anything about this server. Shown under Notes in its session.</Hint>
      </Row>
    </Group>
  );

  const proxyMode: "direct" | "jump" | "socks5" | "http" = newNode.jumpHostId ? "jump" : isSsh && (newNode.proxyType === "socks5" || newNode.proxyType === "http") ? newNode.proxyType : "direct";
  const jumpCandidates = (servers ?? []).filter((s: any) => s.id !== newNode.id && (s.protocol ?? "ssh") === "ssh");
  const setProxyMode = (mode: typeof proxyMode) => {
    if (mode === "jump") set({ jumpHostId: newNode.jumpHostId || (jumpCandidates[0]?.id?.toString() ?? ""), proxyType: "none" });
    else set({ jumpHostId: "", proxyType: mode === "direct" ? "none" : mode });
  };

  const proxy = (
    <Group>
      <Row label="Connect">
        <Seg
          label="How to reach the server"
          value={proxyMode}
          onChange={setProxyMode}
          options={isSsh
            ? [{ value: "direct", label: "Directly" }, { value: "jump", label: "Jump host" }, { value: "socks5", label: "SOCKS5" }, { value: "http", label: "HTTP" }]
            : [{ value: "direct", label: "Directly" }, { value: "jump", label: "Through an SSH server" }]}
        />
      </Row>
      {proxyMode === "jump" && (
        <Row label={isSsh ? "Jump host" : "SSH server"} htmlFor="srv-jump">
          <select id="srv-jump" value={newNode.jumpHostId ?? ""} onChange={(e) => set({ jumpHostId: e.target.value })} className="field">
            {jumpCandidates.length === 0 && <option value="">No SSH servers saved yet</option>}
            {jumpCandidates.map((s: any) => <option key={s.id} value={s.id.toString()}>{s.name} ({s.host})</option>)}
          </select>
          <Hint>
            {jumpHost
              ? `Submarine connects to ${jumpHost.name} first, then goes on to this server from there.`
              : "Pick the SSH server to go through."}
          </Hint>
          {isSsh && newNode.proxyType && newNode.proxyType !== "none" && (
            <Hint tone="warn">
              Also set: a {newNode.proxyType === "http" ? "HTTP" : "SOCKS5"} proxy at {newNode.proxyHost}:{newNode.proxyPort}.{" "}
              <button type="button" className="underline hover:text-white" onClick={() => set({ proxyType: "none" })}>Remove it</button>
            </Hint>
          )}
        </Row>
      )}
      {(proxyMode === "socks5" || proxyMode === "http") && (<>
        <Row label="Proxy host" htmlFor="srv-proxy-host">
          <input
            id="srv-proxy-host" data-field="proxyHost" type="text" value={newNode.proxyHost || ""} placeholder="proxy.example.com"
            onChange={(e) => set({ proxyHost: e.target.value })} onBlur={touch("proxyHost")}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            aria-invalid={!!issueFor("proxyHost")}
            className={fieldCls(!!issueFor("proxyHost"), "font-mono")}
          />
          {issueFor("proxyHost") && <Hint tone="err">{issueFor("proxyHost")!.message}</Hint>}
        </Row>
        <Row label="Proxy port" htmlFor="srv-proxy-port">
          <input
            id="srv-proxy-port" data-field="proxyPort" type="text" inputMode="numeric" value={newNode.proxyPort ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              set({ proxyPort: /^\d+$/.test(v) ? Number(v) : v });
            }}
            onBlur={touch("proxyPort")}
            aria-invalid={!!issueFor("proxyPort")}
            className={fieldCls(!!issueFor("proxyPort"), "font-mono w-28")}
          />
          {issueFor("proxyPort") ? <Hint tone="err">{issueFor("proxyPort")!.message}</Hint> : <Hint>The proxy looks the server's name up.</Hint>}
        </Row>
      </>)}
    </Group>
  );

  const forward = (
    <>
      <p className="mb-3 text-[12px] text-zinc-500 leading-[17px]">
        Local: a port here reaches a host the server can see. Remote: a port on the server reaches one here. Dynamic: a SOCKS proxy here that goes out through the server.
      </p>
      {tunnels.length > 0 && (
        <Group>
          <div className="hidden sm:grid grid-cols-[96px_minmax(0,1fr)_16px_minmax(0,1.4fr)_76px_28px] gap-2 px-3.5 pt-2.5 pb-1.5 text-[11.5px] text-zinc-500">
            <span>Type</span><span>Port</span><span /><span>Target</span><span>Port</span><span />
          </div>
          {tunnels.map((t, idx) => {
            const key = t.rid ?? idx;
            const target = splitTarget(String(t.remote ?? ""));
            const errs = [issueFor(`tunnel-${key}-local`), issueFor(`tunnel-${key}-host`), issueFor(`tunnel-${key}-port`)].filter(Boolean) as Issue[];
            return (
              <div key={key} className="px-3.5 py-2.5 space-y-2">
                <div className="grid grid-cols-[96px_minmax(0,1fr)_28px] sm:grid-cols-[96px_minmax(0,1fr)_16px_minmax(0,1.4fr)_76px_28px] gap-2 items-center">
                  <select aria-label="Forward type" value={t.type} onChange={(e) => setTunnel(idx, { type: e.target.value })} className="field">
                    <option value="L">Local</option>
                    <option value="R">Remote</option>
                    <option value="D">Dynamic</option>
                  </select>
                  <input
                    data-field={`tunnel-${key}-local`} aria-label={t.type === "R" ? "Port on the server" : "Port here"}
                    placeholder={t.type === "D" ? "1080" : "8080"} value={t.local ?? ""}
                    onChange={(e) => setTunnel(idx, { local: e.target.value })} onBlur={touch(`tunnel-${key}-local`)}
                    aria-invalid={!!issueFor(`tunnel-${key}-local`)}
                    className={fieldCls(!!issueFor(`tunnel-${key}-local`), "font-mono")}
                  />
                  <button type="button" aria-label="Remove this forward" onClick={() => set({ tunnels: tunnels.filter((_, i) => i !== idx) })} className="icon-btn sm:order-last hover:text-danger">
                    <Trash2 size={13} />
                  </button>
                  {t.type !== "D" ? (<>
                    <ArrowRight size={13} className="hidden sm:block text-zinc-500" aria-hidden="true" />
                    <div className="col-span-3 sm:col-span-2 grid grid-cols-[minmax(0,1fr)_76px] sm:grid-cols-[minmax(0,1.4fr)_76px] gap-2">
                    <input
                      data-field={`tunnel-${key}-host`} aria-label="Target host" placeholder="localhost" value={target.host}
                      onChange={(e) => setTunnel(idx, { remote: joinTarget(e.target.value, target.port) })} onBlur={touch(`tunnel-${key}-host`)}
                      aria-invalid={!!issueFor(`tunnel-${key}-host`)}
                      className={fieldCls(!!issueFor(`tunnel-${key}-host`), "font-mono")}
                    />
                    <input
                      data-field={`tunnel-${key}-port`} aria-label="Target port" placeholder="80" inputMode="numeric" value={target.port}
                      onChange={(e) => setTunnel(idx, { remote: joinTarget(target.host, e.target.value) })} onBlur={touch(`tunnel-${key}-port`)}
                      aria-invalid={!!issueFor(`tunnel-${key}-port`)}
                      className={fieldCls(!!issueFor(`tunnel-${key}-port`), "font-mono")}
                    />
                    </div>
                  </>) : (
                    <span className="hidden sm:block col-span-3 text-[12px] text-zinc-500">SOCKS5 proxy, out through the server</span>
                  )}
                </div>
                {/* Its name, and whether it starts with the connection: a
                    forward stopped in the Tunnels tool stays here, stopped. */}
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Forward name" placeholder="Name (optional)" maxLength={64} value={t.name ?? ""}
                    onChange={(e) => setTunnel(idx, { name: e.target.value })}
                    className="field flex-1 min-w-0 h-6 text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() => setTunnel(idx, { stopped: !t.stopped })}
                    aria-pressed={!t.stopped}
                    title={t.stopped ? "Kept, but not started on connect. Click to start it on connect." : "Started on connect. Click to keep it stopped."}
                    className={`chip shrink-0 ${t.stopped ? "" : "bg-success/10 text-success"}`}
                  >
                    {t.stopped ? <Square size={10} /> : <Play size={10} fill="currentColor" />}
                    {t.stopped ? "Stopped" : "On connect"}
                  </button>
                </div>
                {errs.map((e) => <Hint key={e.field} tone="err">{e.message}</Hint>)}
              </div>
            );
          })}
        </Group>
      )}
      <button
        type="button"
        onClick={() => set({ tunnels: [...tunnels, { rid: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, local: "", remote: "localhost:", type: "L" }] })}
        className="btn btn-sm mt-3"
      >
        <Plus size={12} /> Add forward
      </button>
    </>
  );

  const pickLocalFolder = (idx: number) =>
    invoke<string | null>("pick_local_directory").then((p) => { if (p) setMirror(idx, { local: p }); }, () => {});

  const mirrorsSection = (
    <>
      <p className="mb-3 text-[12px] text-zinc-500 leading-[17px]">
        A folder here kept copied to the server as you change it. Start and stop them in the session's Mirror tool.
      </p>
      <div className="space-y-3">
        {mirrors.map((m, idx) => (
          <Group key={idx}>
            <Row label="Folder here" htmlFor={`mir-${idx}-local`}>
              <div className="flex gap-2">
                <input
                  id={`mir-${idx}-local`} data-field={`mirror-${idx}-local`} placeholder="~/Projects/app" value={m.local ?? ""}
                  onChange={(e) => setMirror(idx, { local: e.target.value })} onBlur={touch(`mirror-${idx}-local`)}
                  aria-invalid={!!issueFor(`mirror-${idx}-local`)}
                  className={fieldCls(!!issueFor(`mirror-${idx}-local`), "font-mono flex-1 min-w-0")}
                />
                {!IS_ANDROID && <button type="button" onClick={() => pickLocalFolder(idx)} className="btn">Choose…</button>}
              </div>
              {issueFor(`mirror-${idx}-local`) && <Hint tone="err">{issueFor(`mirror-${idx}-local`)!.message}</Hint>}
            </Row>
            <Row label="Folder on the server" htmlFor={`mir-${idx}-remote`}>
              <input
                id={`mir-${idx}-remote`} data-field={`mirror-${idx}-remote`} placeholder="/var/www/app" value={m.remote ?? ""}
                onChange={(e) => setMirror(idx, { remote: e.target.value })} onBlur={touch(`mirror-${idx}-remote`)}
                aria-invalid={!!issueFor(`mirror-${idx}-remote`)}
                className={fieldCls(!!issueFor(`mirror-${idx}-remote`), "font-mono")}
              />
              {issueFor(`mirror-${idx}-remote`) && <Hint tone="err">{issueFor(`mirror-${idx}-remote`)!.message}</Hint>}
            </Row>
            <Row label="On first sync">
              <Seg
                label="When a file differs on both sides"
                value={m.conflict_resolution || "local"}
                onChange={(conflict_resolution) => setMirror(idx, { conflict_resolution })}
                options={[{ value: "local", label: "This side wins" }, { value: "remote", label: "Server wins" }, { value: "newer", label: "Newer wins" }]}
              />
              <Hint>Which copy is kept when a file is on both sides and differs. A file on one side only is always copied.</Hint>
            </Row>
            <Row label="Deleted files">
              <div className="flex items-center gap-3">
                <Switch label="Keep deleted files" checked={m.soft_delete !== false} onChange={(soft_delete) => setMirror(idx, { soft_delete })} />
                <span className="text-[12px] text-zinc-500">{m.soft_delete !== false ? "Moved aside on the server, not deleted" : "Deleted on the server too"}</span>
              </div>
            </Row>
            <Row label="Skip" htmlFor={`mir-${idx}-ex`}>
              <input
                id={`mir-${idx}-ex`} placeholder=".git, node_modules, *.swp" value={(m.excludes || []).join(", ")}
                onChange={(e) => setMirror(idx, { excludes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                className="field font-mono"
              />
            </Row>
            <div className="px-3.5 py-2 flex justify-end">
              <button type="button" onClick={() => set({ mirrors: mirrors.filter((_, i) => i !== idx) })} className="btn btn-sm btn-ghost hover:text-danger">
                <Trash2 size={12} /> Remove mirror
              </button>
            </div>
          </Group>
        ))}
      </div>
      <button
        type="button"
        onClick={() => set({ mirrors: [...mirrors, { local: "", remote: "", soft_delete: true, excludes: [], conflict_resolution: "local" }] })}
        className="btn btn-sm mt-3"
      >
        <Plus size={12} /> Add mirror
      </button>
    </>
  );

  const startup = (
    <Group>
      <Row label="Run after login" htmlFor="srv-run" top>
        <textarea
          id="srv-run" rows={4} spellCheck={false} value={newNode.runOnConnect || ""}
          onChange={(e) => set({ runOnConnect: e.target.value })}
          placeholder={"cd /var/www\nsource .venv/bin/activate"}
          className="field h-auto py-2 font-mono leading-[18px] resize-y"
        />
        <Hint>One command per line, typed into the first terminal once it connects. Not on reconnects or extra terminals.</Hint>
      </Row>
      <Row label="Open at start">
        <div className="flex items-center gap-3">
          <Switch label="Open at start" checked={!!newNode.autostart} onChange={(autostart) => set({ autostart })} />
          <span className="text-[12px] text-zinc-500">Connects when you unlock this profile.</span>
        </div>
      </Row>
    </Group>
  );

  // RDP and VNC options are this device's own (util/rdpOptions,
  // util/vncOptions), not synced.
  const display = (() => {
    if (isRdp) {
      const o: RdpOptions = newNode.rdpOptions || DEFAULT_RDP_OPTIONS;
      const setO = (patch: Partial<RdpOptions>) => set({ rdpOptions: { ...o, ...patch } });
      const size = `${o.width}x${o.height}`;
      const known = RDP_WINDOW_SIZES.some(([w, h]) => w === o.width && h === o.height);
      const builtin = IS_ANDROID || o.app === "builtin";
      return (
        <div className="space-y-3">
          <Group>
            {!IS_ANDROID && (
              <Row label="Open in">
                <Seg
                  label="Open in"
                  value={o.app === "builtin" ? "builtin" : "system"}
                  onChange={(app) => setO({ app })}
                  options={[{ value: "system", label: "This computer's RDP app" }, { value: "builtin", label: "Submarine's tab" }]}
                />
              </Row>
            )}
            {!builtin && (<>
              <Row label="Window" htmlFor="rdp-window">
                <select
                  id="rdp-window" className="field"
                  value={o.fullScreen ? "full" : size}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "full") return setO({ fullScreen: true });
                    const [width, height] = v.split("x").map(Number);
                    setO({ fullScreen: false, width, height });
                  }}
                >
                  <option value="full">Full screen</option>
                  {RDP_WINDOW_SIZES.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</option>)}
                  {!o.fullScreen && !known && <option value={size}>{o.width} × {o.height}</option>}
                </select>
              </Row>
              <Row label="Clipboard">
                <div className="flex items-center gap-3">
                  <Switch label="Share the clipboard" checked={o.clipboard} onChange={(clipboard) => setO({ clipboard })} />
                  <span className="text-[12px] text-zinc-500">Copy and paste between this computer and the server.</span>
                </div>
              </Row>
              <Row label="Files">
                <div className="flex items-center gap-3">
                  <Switch label="Share this computer's files" checked={o.drives} onChange={(drives) => setO({ drives })} />
                  <span className="text-[12px] text-zinc-500">The server can read and change them (with Remmina: your home folder).</span>
                </div>
              </Row>
            </>)}
          </Group>
          {builtin && (<>
            <div role="note" className="flex gap-2 p-2.5 rounded-lg bg-amber-500/10 text-[12px] leading-[17px] text-amber-300">
              <FlaskConical size={14} className="shrink-0 mt-px" aria-hidden="true" />
              <span>{RDP_BUILTIN_EXPERIMENTAL} The desktop opens in the server's tab, sized to it; the saved password is used, or asked for there.</span>
            </div>
            <Group className="p-3.5 space-y-3 divide-y-0">
              <SwitchRow
                label="Allow servers without NLA"
                hint="NLA makes the server prove it knows the password before it is sent. Off, a server without it is refused and nothing is sent; on, the password goes inside TLS only."
                checked={!!o.allowNoNla}
                onChange={(allowNoNla) => setO({ allowNoNla })}
              />
              <SwitchRow
                label="Share the clipboard"
                hint="Text you copy on the server comes to this device. This device's text goes to the server only when you paste it there (a paste key in the tab, or its Paste button)."
                checked={o.clipboard}
                onChange={(clipboard) => setO({ clipboard })}
              />
              {!IS_ANDROID && <RdpShareFields o={o} set={setO} drives={localDrives} />}
              <div className="pt-1 space-y-2.5">
                <div className="font-medium text-white">Speed and quality</div>
                <RdpSpeedFields o={o} set={setO} />
              </div>
            </Group>
          </>)}
          <Hint>Kept on this device only, not synced.</Hint>
        </div>
      );
    }
    const o: VncOptions = newNode.vncOptions || DEFAULT_VNC_OPTIONS;
    const setO = (patch: Partial<VncOptions>) => set({ vncOptions: normalizeVncOptions({ ...o, ...patch }) });
    return (
      <div className="space-y-3">
        <Group className="p-3.5 space-y-3 divide-y-0">
          <SwitchRow
            label="Share the clipboard"
            hint="Text you copy on the server comes to this device; this device's goes to the server when you paste it there. Plain ASCII text only, such as links and commands: a VNC clipboard can't carry other characters."
            checked={o.clipboard}
            onChange={(clipboard) => setO({ clipboard })}
          />
          <div className="font-medium text-white">Speed and quality</div>
          <VncSpeedFields o={o} set={setO} />
        </Group>
        <Hint>Kept on this device only, not synced.</Hint>
      </div>
    );
  })();

  const body: Record<EditorSection, ReactNode> = { connection, auth, org, proxy, forward, mirrors: mirrorsSection, startup, display };
  const sectionTitle = shownSection === "display" ? (isRdp ? "Remote desktop" : "Screen") : SECTION_META[shownSection].label;

  // ---- Test result line ----------------------------------------------------

  const testLine = (() => {
    if (test.kind === "idle") return <span className="text-zinc-500">{isSsh ? "Checks the name, the port and the host key" : "Checks the name and the port"}. Nothing is saved.</span>;
    if (test.kind === "blocked") return <span className="text-danger">Fix the highlighted fields first.</span>;
    if (test.kind === "running") {
      return (
        <span className="inline-flex items-center gap-2 text-zinc-400">
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" aria-hidden="true" />
          Connecting to {test.label}…
        </span>
      );
    }
    const r = test.result;
    const via = test.via ? `${test.via}: ` : "";
    if (r.failed) return <span className="text-danger">{via}{r.error}</span>;
    const reached = `${via}Reached ${r.addresses[0] ?? test.label}${r.connect_ms != null ? ` in ${r.connect_ms} ms` : ""}.`;
    const k = r.host_key;
    if (!k) return <span className="text-success">{reached} The port is open.</span>;
    const fp = k.fingerprint ? <span className="font-mono"> {k.fingerprint}</span> : null;
    switch (k.trust) {
      case "known":
      case "known_hosts":
        return <span className="text-success" title={k.note ?? undefined}>{reached} Host key matches the one you trust.</span>;
      case "new":
        return <span className="text-zinc-300">{reached} New host key, you'll be asked to trust it when connecting:{fp}</span>;
      case "changed":
        return <span className="text-danger">{reached} The host key has changed since you trusted it. Check with the server's admin before connecting:{fp}</span>;
      case "refused":
        return <span className="text-danger">{reached} Host key refused: {k.note}</span>;
      default:
        return <span className="text-warning">{reached} The server shows a host certificate that no @cert-authority line in your known_hosts covers.</span>;
    }
  })();

  const tagColour = tag ?? "rgb(var(--subtle))";
  const HeaderIcon = isRdp || isVnc ? Monitor : Server;

  return (
    // Mounted while closed too (to animate out): inert then.
    <div
      inert={isOpen ? undefined : ""}
      className={`fixed inset-0 z-50 flex items-start justify-center sm:pt-[6vh] transition-opacity duration-200 ${isOpen ? "bg-scrim" : "opacity-0 pointer-events-none"}`}
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="srv-editor-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={`w-full h-full sm:w-[min(800px,calc(100%-32px))] sm:h-[min(640px,88vh)] flex flex-col bg-elevated sm:rounded-xl shadow-sheet overflow-hidden outline-none text-[13px] transition-[transform,opacity] duration-200 ease-out ${isOpen ? "" : "translate-y-2 scale-[0.98] opacity-0"}`}
      >
        <header className="flex items-center gap-3 px-5 pt-[18px] pb-3.5 border-b border-white/[0.075] shrink-0">
          <span className="w-9 h-9 rounded-[9px] bg-white/[0.06] flex items-center justify-center shrink-0" style={{ color: tagColour }} aria-hidden="true">
            <HeaderIcon size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id="srv-editor-title" className="text-[15px] leading-5 font-semibold text-white truncate">
              {isEditMode ? `Edit ${newNode.name || "server"}` : "New server"}
            </h2>
            <div className="text-[12px] text-zinc-400 truncate flex items-center gap-1.5">
              {isEditMode && edited && <History size={11} className="shrink-0" aria-hidden="true" />}
              <span className="truncate" title={edited ? edited.toLocaleString() : undefined}>{subtitle}</span>
            </div>
          </div>
          {!isEditMode && isSsh && (
            <button type="button" onClick={() => setImportOpen(true)} className="btn" title="Import from ~/.ssh/config, PuTTY, MobaXterm or JSON">
              <Download size={13} /> <span className="hidden sm:inline">Import…</span>
            </button>
          )}
          <button type="button" aria-label="Close" onClick={onClose} className="icon-btn">
            <X size={15} />
          </button>
        </header>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <nav aria-label="Server settings" className="shrink-0 md:w-[200px] md:border-r border-b md:border-b-0 border-white/[0.075] px-2.5 py-2 md:py-3 flex md:flex-col gap-0.5 overflow-x-auto no-scrollbar">
            {sections.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const n = sectionIssues(s);
              const on = s === shownSection;
              const label = s === "display" ? (isRdp ? "Remote desktop" : "Screen") : meta.label;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSection(s)}
                  aria-current={on ? "page" : undefined}
                  className={`flex items-center gap-2 h-[30px] px-2.5 rounded-md text-left whitespace-nowrap shrink-0 md:w-full transition-colors ${on ? "bg-primary/[0.14] text-white" : "text-white hover:bg-white/[0.05]"}`}
                >
                  <Icon size={14} className={on ? "text-primary" : "text-zinc-400"} aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  {n > 0 && (
                    <span className="pill h-4 px-1.5 text-[10.5px] bg-danger text-snow" title={`${n} issue${n === 1 ? "" : "s"}`}>
                      {n}<span className="sr-only"> issue{n === 1 ? "" : "s"}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div ref={contentRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 sm:px-[22px] py-[18px]">
            {formError && (
              <div role="alert" className="mb-3 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-[12px] flex gap-2">
                <ShieldAlert size={14} className="shrink-0 mt-px" aria-hidden="true" />
                <span>{formError}</span>
              </div>
            )}
            <h3 className="mb-3 text-[15px] leading-5 font-semibold text-white">{sectionTitle}</h3>
            {body[shownSection]}
          </div>
        </div>

        <footer className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 px-5 py-3 border-t border-white/[0.075] shrink-0">
          <button type="button" onClick={runTest} disabled={test.kind === "running"} className="btn shrink-0">
            Test connection
          </button>
          <div role="status" aria-live="polite" className="flex-1 min-w-0 order-last sm:order-none basis-full sm:basis-auto text-[12px] leading-4 break-words line-clamp-2">
            {testLine}
          </div>
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <button type="button" onClick={onClose} className="btn">
              Cancel <kbd className="hidden sm:inline text-[11px] text-zinc-500 font-sans">esc</kbd>
            </button>
            <button type="button" onClick={save} className="btn btn-primary">
              {isEditMode ? "Save" : "Add server"} <kbd className="hidden sm:inline text-[11px] opacity-70 font-sans">{IS_MAC ? "⌘S" : "Ctrl+S"}</kbd>
            </button>
          </div>
        </footer>
      </div>

      <ServerImportDialog
        open={importOpen}
        request={importRequest}
        onClose={() => setImportOpen(false)}
        refreshServers={refreshServers}
        refreshSshKeys={refreshSshKeys}
      />
    </div>
  );
};

export default ServerEditor;
