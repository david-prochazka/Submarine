import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalSquare, Palette, RefreshCw, List, Cloud, Minus, Plus, ArrowRight, X, KeyRound, EyeOff, Monitor, Moon, Sun } from "lucide-react";
import {
  MAX_FONT_SIZE, MIN_FONT_SIZE, clampFontSize, fontFamilyCss,
  isFontAvailable, primaryFontName, sanitizeFontFamily,
} from "../util/terminalFont";
import {
  ShellSyncPair, localPathProblem, readShellSyncPairs, readShellSyncServers, remotePathProblem,
  setShellSyncServer, writeShellSyncPairs,
} from "../util/shellSync";
import { invoke } from "@tauri-apps/api/core";
import CopyValue from "./CopyValue";
import FontPicker from "./FontPicker";
import { loadInstalledFonts } from "../util/systemFonts";
import { MAX_SCROLLBACK, MIN_SCROLLBACK, clampScrollback } from "../util/terminalScrollback";
import {
  CUSTOM_THEME_ID, DEFAULT_THEME_ID, SCHEMES, TerminalScheme, XTERM_ANSI,
  parseWindowsTerminalScheme, schemeToWindowsTerminalJson,
} from "../util/terminalTheme";
import { IS_ANDROID } from "../util/platform";
import { useConfirm } from "../ui/confirm";

// Where this install keeps its data (see src-tauri/src/portable.rs). `portable`
// means a `submarine-data` folder next to the executable is in use; `warning`
// is set when such a folder exists but couldn't be written to.
interface StorageInfo {
  portable: boolean;
  data_dir: string;
  warning: string | null;
}

// Slider covers the everyday range; the number field takes anything 1–99.
const SLIDER_MAX = 40;

// "Use my default shell" (open_terminal in lib.rs): offered only where this
// computer has a shell of its own to start, which the backend knows
// (`local_shell`: none on Windows and Android, or without $SHELL).
function DefaultShellSetting({ settings, setSettings }: any) {
  const [shell, setShell] = useState<string | null>(null);
  useEffect(() => {
    invoke<string | null>("local_shell").then(setShell, () => setShell(null));
  }, []);
  if (!shell) return null;
  const name = shell.split("/").pop();
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium text-white">Use my default shell</div>
          <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
            New terminals start {name}, the shell this computer uses, as a login shell on the
            server in place of the account's own. {name} reads the server's own startup files;
            nothing is copied from here. The server's welcome message isn't shown in these
            terminals. A server without {name}, or one that can't start it this way (a Windows
            server, some network devices), opens the account's own shell as before.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={!!settings.useLocalShell}
          aria-label="Use my default shell"
          onClick={() => setSettings((s: any) => ({ ...s, useLocalShell: !s.useLocalShell }))}
          className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${settings.useLocalShell ? 'bg-primary' : 'bg-white/[0.08]'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${settings.useLocalShell ? 'translate-x-[14px]' : ''}`} />
        </button>
      </div>
    </div>
  );
}

// "Use keys from an ssh-agent" (util/sshAgent, src-tauri/src/agent_auth.rs).
function SshAgentSetting({ settings, setSettings }: any) {
  const on = settings.useSshAgent !== false;
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium text-white">Use keys from an ssh-agent</div>
          <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
            Log in with keys held by an ssh-agent on this computer: Pageant, the Windows OpenSSH
            agent and agents that use its pipe (such as 1Password), the agent in SSH_AUTH_SOCK, or
            the one IdentityAgent names in ~/.ssh/config.
            Smartcards and hardware keys work through it. It's used only when a server has no saved
            password or key, its key's passphrase isn't saved, or the server turns its key down.
            Turn off to use only what's saved for each server.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label="Use keys from an ssh-agent"
          onClick={() => setSettings((s: any) => ({ ...s, useSshAgent: !(s.useSshAgent !== false) }))}
          className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${on ? 'bg-primary' : 'bg-white/[0.08]'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${on ? 'translate-x-[14px]' : ''}`} />
        </button>
      </div>
    </div>
  );
}

// "Use settings from ~/.ssh/config" (util/sshConfig, src-tauri/src/ssh_config.rs).
function SshConfigSetting({ settings, setSettings }: any) {
  const on = settings.useSshConfig !== false;
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium text-white">Use settings from ~/.ssh/config</div>
          <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
            Connect the way the OpenSSH client would: a server whose address is an alias in
            ~/.ssh/config connects to its HostName and Port, takes its User when no username is
            saved, uses the ssh-agent IdentityAgent names, and goes through its ProxyCommand (such
            as cloudflared or tsh) or ProxyJump unless the server has a jump host or proxy of its
            own. Its IdentityFile keys and CertificateFile certificates log in when a server has
            no saved password or key (Teleport, for one), and the host keys and certificate
            authorities in your known_hosts are trusted without the first-time prompt. Host
            blocks are matched against a server's address and its name; Include and Match are
            followed, Match exec is never run. These files are only read, and nothing from them
            is synced. Turn off to use only what's saved for each server.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label="Use settings from ~/.ssh/config"
          onClick={() => setSettings((s: any) => ({ ...s, useSshConfig: !(s.useSshConfig !== false) }))}
          className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${on ? 'bg-primary' : 'bg-white/[0.08]'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${on ? 'translate-x-[14px]' : ''}`} />
        </button>
      </div>
    </div>
  );
}

// "Block screenshots" (Android only): FLAG_SECURE on the app's window. Kept
// on the device by the app's Android plugin rather than in these settings, so
// it applies from the first frame when the app starts (android_bridge.rs).
function SecureScreenSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invoke<boolean>("get_secure_screen").then(setOn, (e) => setError(String(e)));
  }, []);
  const toggle = () => {
    if (on === null) return;
    setError(null);
    invoke<boolean>("set_secure_screen", { enabled: !on }).then(setOn, (e) => setError(String(e)));
  };
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium text-white">Block screenshots</div>
          <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
            Keep Supermarine out of screenshots, screen recordings and screen sharing, so passwords and
            terminal output can't be captured, not even by an app that records the screen. You
            can't take screenshots of it yourself while this is on. The preview in the recent
            apps list is always hidden (Android 13 and later).
          </p>
          {error && <p className="text-[12px] text-rose-300 mt-2 break-words">{error}</p>}
        </div>
        <button
          role="switch"
          aria-checked={!!on}
          aria-label="Block screenshots"
          disabled={on === null}
          onClick={toggle}
          className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] disabled:opacity-50 ${on ? 'bg-primary' : 'bg-white/[0.08]'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${on ? 'translate-x-[14px]' : ''}`} />
        </button>
      </div>
    </div>
  );
}

// Terminal font face + size. Both are drafts while you type: the size field
// can sit empty mid-edit (it used to snap back to 14 the moment it was
// cleared, which made small sizes impossible to type on Android), and the
// face is applied ~0.5 s after you stop typing instead of re-measuring every
// open terminal on each keystroke.
function TerminalFontSettings({ settings, setSettings }: any) {
  const size = clampFontSize(settings.terminalFontSize);
  const family: string = settings.terminalFontFamily || "";

  const [sizeDraft, setSizeDraft] = useState(String(size));
  useEffect(() => setSizeDraft(String(size)), [size]);
  const setSize = (n: number) =>
    setSettings((s: any) => ({ ...s, terminalFontSize: clampFontSize(n) }));

  const [familyDraft, setFamilyDraft] = useState(family);
  useEffect(() => setFamilyDraft(family), [family]);
  const commitTimer = useRef<number | null>(null);
  useEffect(() => () => { if (commitTimer.current) window.clearTimeout(commitTimer.current); }, []);
  const commitFamily = (v: string) => {
    if (commitTimer.current) { window.clearTimeout(commitTimer.current); commitTimer.current = null; }
    const clean = sanitizeFontFamily(v);
    setSettings((s: any) => (s.terminalFontFamily === clean ? s : { ...s, terminalFontFamily: clean }));
  };
  const onFamilyChange = (v: string) => {
    setFamilyDraft(v);
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => commitFamily(v), 500);
  };

  // Families installed on this device: the list the picker shows. The canvas
  // probe in isFontAvailable can miss a font the webview does draw (seen on
  // macOS, #59), and a font picked under "Installed on this device" must not
  // then be called missing. No warning until the list is in, so it can't
  // flash on and off; if the list can't be read, the probe decides alone.
  const [listed, setListed] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    loadInstalledFonts().then(
      (fonts) => { if (alive) setListed(new Set(fonts.map((f) => f.family.toLowerCase()))); },
      () => { if (alive) setListed(new Set()); },
    );
    return () => { alive = false; };
  }, []);

  const installed = useMemo(
    () => listed === null || listed.has(primaryFontName(familyDraft).toLowerCase()) || isFontAvailable(familyDraft),
    [familyDraft, listed],
  );
  const previewFamily = fontFamilyCss(familyDraft);

  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-5">
      {/* Font face */}
      <div className="space-y-2">
        <div className="flex justify-between items-center gap-2">
          <label htmlFor="term-font-family" className="font-medium text-white">Font</label>
          {familyDraft && (
            <button
              type="button"
              onClick={() => { setFamilyDraft(""); commitFamily(""); }}
              className="btn btn-ghost btn-sm -mr-2"
            >
              Use default
            </button>
          )}
        </div>
        <FontPicker
          value={familyDraft}
          onChange={onFamilyChange}
          onCommit={commitFamily}
          placeholder="Default monospace — pick from the list or type a font name"
        />
        {!installed && (
          <p className="text-[11.5px] text-amber-400/90">
            "{primaryFontName(familyDraft)}" doesn't seem to be installed on this device, so the default font is used instead.
          </p>
        )}
        <p className="text-[12px] text-zinc-500 leading-[16px]">
          Built-in fonts ship with the app and work on every device. Any font installed on this device works too, including Nerd Fonts for starship / powerline prompts.
        </p>
      </div>

      {/* Font size */}
      <div className="space-y-3 pt-5 border-t border-white/[0.075]">
        <div className="flex justify-between items-center gap-3">
          <label htmlFor="term-font-size" className="font-medium text-white">Font size</label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Smaller font"
              onClick={() => setSize(size - 1)}
              disabled={size <= MIN_FONT_SIZE}
              className="btn w-7 px-0"
            >
              <Minus size={13} aria-hidden />
            </button>
            <input
              id="term-font-size"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={sizeDraft}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                setSizeDraft(v);
                const n = parseInt(v, 10);
                if (n >= MIN_FONT_SIZE) setSize(n);
              }}
              onBlur={() => setSizeDraft(String(size))}
              className="field w-12 px-1 text-center tabular-nums"
            />
            <button
              type="button"
              aria-label="Larger font"
              onClick={() => setSize(size + 1)}
              disabled={size >= MAX_FONT_SIZE}
              className="btn w-7 px-0"
            >
              <Plus size={13} aria-hidden />
            </button>
          </div>
        </div>
        <input
          type="range"
          aria-label="Font size"
          min={MIN_FONT_SIZE}
          max={SLIDER_MAX}
          value={Math.min(size, SLIDER_MAX)}
          onChange={(e) => setSize(parseInt(e.target.value, 10))}
          className="w-full accent-primary"
        />
        <p className="text-[12px] text-zinc-500 leading-[16px]">Any size from {MIN_FONT_SIZE} to {MAX_FONT_SIZE} — type it in or use the − / + buttons.</p>
      </div>

      {/* Live preview */}
      <div className="rounded-lg bg-terminal px-3 py-2.5 overflow-x-auto custom-scrollbar">
        <pre
          className="m-0 whitespace-pre text-zinc-100 leading-snug"
          style={{ fontFamily: previewFamily, fontSize: Math.min(size, 28) }}
        >
          <span className="text-primary">user@server</span>:~$ ls -la{"\n"}0O 1lI | {"{}"} [] =&gt; ✓
        </pre>
      </div>
    </div>
  );
}

// A few lines of `ls -l` in a scheme's colours, to pick one by.
function SchemePreview({ scheme, boldBright }: { scheme: TerminalScheme; boldBright: boolean }) {
  const t = scheme.theme;
  // The default scheme leaves the ANSI colours to xterm; these are xterm's.
  const c = (k: keyof typeof XTERM_ANSI) => (t as Record<string, string | undefined>)[k] ?? XTERM_ANSI[k];
  // Bold text, in the bright colour when the terminal draws it that way.
  const b = (k: "red" | "green" | "blue" | "cyan") => ({
    color: c(boldBright ? (`bright${k[0].toUpperCase()}${k.slice(1)}` as keyof typeof XTERM_ANSI) : k),
    fontWeight: 700,
  });
  const fg = t.foreground ?? "#e4e4e7";
  return (
    <div
      aria-hidden="true"
      className="rounded-lg border border-white/10 px-3 py-2 font-mono text-[11px] leading-[1.45] overflow-hidden whitespace-pre"
      style={{ background: t.background, color: fg }}
    >
      {/* Short lines: they fit a phone's width too. */}
      <div><span style={b("green")}>user@server</span>:<span style={b("blue")}>~</span>$ ls -lh</div>
      <div>drwxr-xr-x 4.0K <span style={b("blue")}>projects</span></div>
      <div>-rwxr-xr-x  812 <span style={b("green")}>deploy.sh</span></div>
      <div>lrwxrwxrwx   11 <span style={b("cyan")}>logs</span> -&gt; /var/log</div>
      <div>-rw-r--r-- 2.1M <span style={b("red")}>backup.tar.gz</span></div>
      <div><span style={{ color: c("yellow") }}>warning:</span> <span style={{ color: c("magenta") }}>3</span> files changed <span style={{ color: c("brightBlack") }}># comment</span></div>
    </div>
  );
}

// Terminal colours (util/terminalTheme): a scheme, bold in bright colours,
// "keep text readable", and a scheme of the user's own pasted as Windows
// Terminal JSON.
function TerminalColoursSetting({ settings, setSettings }: any) {
  const custom = useMemo(() => {
    if (!settings.terminalCustomScheme) return null;
    try { return parseWindowsTerminalScheme(settings.terminalCustomScheme); } catch { return null; }
  }, [settings.terminalCustomScheme]);
  const schemes = custom ? [...SCHEMES, custom] : SCHEMES;
  const current = schemes.find((s) => s.id === settings.terminalTheme) ?? SCHEMES[0];
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const useImported = () => {
    try {
      if (pasted.length > 20000) throw new Error("That's too long for one colour scheme.");
      const s = parseWindowsTerminalScheme(pasted);
      setSettings((prev: any) => ({ ...prev, terminalCustomScheme: schemeToWindowsTerminalJson(s), terminalTheme: CUSTOM_THEME_ID }));
      setImporting(false);
      setPasted("");
      setImportError(null);
    } catch (e: any) {
      setImportError(e?.message ?? String(e));
    }
  };
  const removeCustom = () =>
    setSettings((prev: any) => ({
      ...prev,
      terminalCustomScheme: "",
      terminalTheme: prev.terminalTheme === CUSTOM_THEME_ID ? DEFAULT_THEME_ID : prev.terminalTheme,
    }));
  const swatch = (s: TerminalScheme) => {
    const t = s.theme as Record<string, string | undefined>;
    const dots = ["red", "green", "yellow", "blue", "magenta", "cyan"].map((k) => t[k] ?? XTERM_ANSI[k as keyof typeof XTERM_ANSI]);
    const on = s.id === current.id;
    return (
      <button
        key={s.id}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => setSettings((prev: any) => ({ ...prev, terminalTheme: s.id }))}
        className={`flex flex-col items-stretch gap-1.5 min-w-0 rounded-lg border p-1.5 text-left transition-colors ${on ? "border-primary/60 bg-primary/10" : "border-white/10 hover:border-white/25"}`}
      >
        {/* The colours on the scheme's background, the name under them: two
            to a row fit a phone without cutting names short. */}
        <span className="flex items-center justify-center gap-[3px] rounded h-5" style={{ background: t.background }}>
          {dots.map((d, i) => <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ background: d }} />)}
        </span>
        <span className={`truncate px-0.5 text-[12px] ${on ? "text-white font-semibold" : "text-zinc-300"}`}>{s.name}</span>
      </button>
    );
  };
  const toggle = (key: "terminalBoldBright" | "terminalMinContrast", label: string, text: string) => (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium text-white">{label}</div>
        <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">{text}</p>
      </div>
      <button
        role="switch"
        aria-checked={!!settings[key]}
        aria-label={label}
        onClick={() => setSettings((s: any) => ({ ...s, [key]: !s[key] }))}
        className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${settings[key] ? "bg-primary" : "bg-white/[0.08]"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${settings[key] ? "translate-x-[14px]" : ""}`} />
      </button>
    </div>
  );
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-4">
      <div className="font-medium text-white">Colours</div>
      <div role="radiogroup" aria-label="Colour scheme" className="grid grid-cols-2 gap-2">
        {schemes.map(swatch)}
      </div>
      <SchemePreview scheme={current} boldBright={settings.terminalBoldBright !== false} />
      {toggle("terminalBoldBright", "Bold text in bright colours",
        "Bold text in one of the first eight colours uses its bright version, as most terminals do.")}
      {toggle("terminalMinContrast", "Keep text readable",
        "Text a program colours too close to the background, like dark blue on black, is drawn lighter or darker so it can be read.")}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { setImporting((v) => !v); setImportError(null); }}
            aria-expanded={importing}
            className="btn"
          >
            {custom ? "Replace my scheme…" : "Use my own scheme…"}
          </button>
          {custom && (
            <button
              type="button"
              onClick={removeCustom}
              className="btn btn-ghost text-danger hover:text-danger"
            >
              Remove {custom.name}
            </button>
          )}
        </div>
        {importing && (
          <div className="space-y-2">
            <p className="text-[12px] text-zinc-500 leading-[16px]">
              Paste a Windows Terminal colour scheme (JSON with name, background, foreground and the
              16 colours from black to brightWhite). Sites that collect terminal schemes offer this format.
            </p>
            <textarea
              value={pasted}
              onChange={(e) => { setPasted(e.target.value); setImportError(null); }}
              rows={6}
              spellCheck={false}
              aria-label="Windows Terminal colour scheme"
              placeholder={'{\n  "name": "My scheme",\n  "background": "#1e1e2e",\n  "foreground": "#cdd6f4",\n  …\n}'}
              className="field h-auto py-1.5 text-[11.5px] font-mono"
            />
            {importError && <p role="alert" className="text-[11.5px] text-rose-300">{importError}</p>}
            <button
              type="button"
              onClick={useImported}
              disabled={!pasted.trim()}
              className="btn btn-primary"
            >
              Use it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Lines each terminal keeps to scroll back through (util/terminalScrollback).
// A typed number applies on Enter or when the field loses focus: applied on
// each keystroke, typing 25000 would pass through 2 and clamp to the minimum.
const SCROLLBACK_STEP = 1000;
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function TerminalScrollbackSetting({ settings, setSettings }: any) {
  const lines = clampScrollback(settings.terminalScrollback);
  const [draft, setDraft] = useState(String(lines));
  useEffect(() => setDraft(String(lines)), [lines]);
  const set = (n: number) =>
    setSettings((s: any) => ({ ...s, terminalScrollback: clampScrollback(n) }));
  const commit = () => {
    const n = parseInt(draft, 10);
    const next = Number.isFinite(n) ? clampScrollback(n) : lines;
    setDraft(String(next));
    if (next !== lines) set(next);
  };
  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-3">
      <div className="flex justify-between items-center gap-3">
        <label htmlFor="term-scrollback" className="font-medium text-white">Scrollback lines</label>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Fewer scrollback lines"
            onClick={() => set(lines - SCROLLBACK_STEP)}
            disabled={lines <= MIN_SCROLLBACK}
            className="btn w-7 px-0"
          >
            <Minus size={13} aria-hidden />
          </button>
          <input
            id="term-scrollback"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            className="field w-[72px] px-1 text-center tabular-nums"
          />
          <button
            type="button"
            aria-label="More scrollback lines"
            onClick={() => set(lines + SCROLLBACK_STEP)}
            disabled={lines >= MAX_SCROLLBACK}
            className="btn w-7 px-0"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <p className="text-[12px] text-zinc-500 leading-[16px]">
        How many lines each terminal keeps to scroll back through, from {groupDigits(MIN_SCROLLBACK)} to{" "}
        {groupDigits(MAX_SCROLLBACK)}. More lines take more memory in every open terminal. A change applies to open
        terminals too; a smaller number drops their oldest lines.
      </p>
    </div>
  );
}

// What the Shell button in a session's toolbar pushes, and which servers show
// it. Both are this device's own (see util/shellSync.ts): the files are this
// machine's, so neither is in the vault. Shell-agnostic on purpose: a plain
// local/remote list, for whatever shell the user runs.
function ShellConfigSyncSettings({ servers }: { servers: any[] }) {
  const [pairs, setPairs] = useState<ShellSyncPair[]>(() => readShellSyncPairs());
  const [chosen, setChosen] = useState<string[]>(() => readShellSyncServers());

  const persist = (next: ShellSyncPair[]) => {
    setPairs(next);
    writeShellSyncPairs(next);
  };
  const toggle = (uuid: string, on: boolean) => {
    setShellSyncServer(uuid, on);
    setChosen(readShellSyncServers());
  };
  // Saved servers (a quick connect has no sync id), by name.
  const choices = servers
    .filter((s) => typeof s.uuid === "string" && s.uuid)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return (
    <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-4">
      <div>
        <div className="font-medium text-white">Shell config sync</div>
        <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
          Files and folders from this computer for the Shell button in a session's toolbar to push
          to that server: your shell config, theme, plugins. The place on the server is below its
          home folder, so one list works whatever the user name. You see what would change before
          anything is sent, and a file it replaces is kept in ~/.submarine-trash on the server.
          Keys, credentials, command history and .git folders are never pushed.
        </p>
      </div>

      <div className="space-y-2">
        {pairs.map((pair, i) => {
          const problem = localPathProblem(pair.local) ?? remotePathProblem(pair.remote);
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={pair.local}
                  onChange={(e) => persist(pairs.map((p, idx) => idx === i ? { ...p, local: e.target.value } : p))}
                  placeholder="~/.zshrc"
                  aria-label="File or folder on this computer"
                  spellCheck={false}
                  className="field flex-1 min-w-0 font-mono text-[12px]"
                />
                <ArrowRight size={14} className="text-zinc-500 shrink-0" />
                <input
                  type="text"
                  value={pair.remote}
                  onChange={(e) => persist(pairs.map((p, idx) => idx === i ? { ...p, remote: e.target.value } : p))}
                  placeholder=".zshrc"
                  aria-label="Place on the server, below its home folder"
                  spellCheck={false}
                  className="field flex-1 min-w-0 font-mono text-[12px]"
                />
                <button
                  onClick={() => persist(pairs.filter((_, idx) => idx !== i))}
                  aria-label="Remove pair"
                  title="Remove pair"
                  className="icon-btn hover:text-danger"
                >
                  <X size={14} />
                </button>
              </div>
              {problem && <p className="text-[12px] text-warning">{problem}</p>}
            </div>
          );
        })}
        {pairs.length === 0 && (
          <p className="text-[12px] text-zinc-500">Nothing to push yet.</p>
        )}
      </div>

      <button
        onClick={() => persist([...pairs, { local: "", remote: "" }])}
        className="btn btn-sm"
      >
        <Plus size={14} /> Add pair
      </button>

      <div className="pt-4 border-t border-white/[0.075]">
        <div className="font-medium text-white">Push to</div>
        <p className="text-[12px] text-zinc-500 mt-0.5">
          The servers that show the Shell button. Only this device keeps the choice.
        </p>
        {choices.length === 0 ? (
          <p className="text-[12px] text-zinc-500 mt-2">No saved servers yet.</p>
        ) : (
          <div className="mt-2 max-h-56 overflow-y-auto custom-scrollbar space-y-0.5 pr-1">
            {choices.map((s) => (
              <label key={s.uuid} className="flex items-center gap-2.5 px-2 h-8 rounded-md hover:bg-white/[0.04] cursor-pointer">
                <input
                  type="checkbox"
                  checked={chosen.includes(s.uuid)}
                  onChange={(e) => toggle(s.uuid, e.target.checked)}
                  className="accent-primary w-4 h-4 shrink-0"
                />
                <span className="text-[13px] text-zinc-200 truncate">{s.name}</span>
                <span className="text-[12px] text-zinc-500 font-mono truncate">{s.host}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SettingsPanel = ({ settings, setSettings, onOpenLogs, servers = [] }: any) => {
  const confirm = useConfirm();
  const accentColors = [
    { name: 'Theme (teal)', value: '' },
    { name: 'Light Blue', value: '#60a5fa' },
    { name: 'Sky', value: '#38bdf8' },
    { name: 'Cyan', value: '#22d3ee' },
    { name: 'Indigo', value: '#818cf8' },
    { name: 'Emerald', value: '#10b981' },
    { name: 'Rose', value: '#f43f5e' },
  ];

  const appearances = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];

  // Read-only storage summary from the backend: where data lives and whether
  // a `submarine-data` folder next to the exe (portable mode) is in use.
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  useEffect(() => {
    invoke<StorageInfo>("get_storage_info").then(setStorage).catch(() => setStorage(null));
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface">
      <header className="h-[52px] shrink-0 flex items-center gap-2 pl-4 pr-3 border-b border-white/[0.075]">
        <span className="flex-1 min-w-0 h-6 flex items-center font-semibold text-white truncate">Settings</span>
      </header>
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pt-5 pb-8 sm:px-8 sm:pt-7 sm:pb-10">
      <div className="mb-6 max-w-[640px]">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-white">Settings</h1>
        <p className="mt-0.5 text-zinc-400">
          These stay on this device. They aren't synced with your profile.
        </p>
      </div>

      {/* Columns rather than a grid: the sections are very different heights, and
          a 2-col grid rows them up so a short card leaves a tall empty gap beside
          it. Column flow packs them, and break-inside-avoid keeps a card whole. */}
      <div className="columns-1 lg:columns-2 gap-6">
        {/* Appearance Section */}
        <section className="break-inside-avoid space-y-2.5 mb-6">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Palette size={14} aria-hidden className="text-zinc-500" /> Interface
          </h2>

          <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-5">
            {/* Accent Color */}
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <label htmlFor="settings-accent" className="font-medium text-white">Accent colour</label>
                <div className="flex items-center gap-2">
                  <input
                    id="settings-accent"
                    type="color"
                    value={settings.primaryColor || '#3ecfc4'} 
                    onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                    className="w-6 h-6 rounded-md bg-transparent cursor-pointer border-none p-0"
                  />
                  <input 
                    type="text" 
                    value={settings.primaryColor} 
                    placeholder="Theme"
                    aria-label="Accent colour, hex"
                    onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                    className="field w-[84px] h-6 px-1.5 text-[11.5px] font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-7 gap-3 justify-items-center">
                {accentColors.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setSettings({ ...settings, primaryColor: c.value })}
                    aria-pressed={settings.primaryColor === c.value}
                    className={`w-full aspect-square max-w-9 rounded-full transition-shadow ${settings.primaryColor === c.value ? 'shadow-[0_0_0_2px_rgb(var(--panel)),0_0_0_4px_rgb(var(--ink))]' : 'hover:shadow-[0_0_0_2px_rgb(var(--panel)),0_0_0_4px_var(--border-strong)]'}`}
                    style={{ backgroundColor: c.value || '#3ecfc4' }}
                    title={c.name}
                    aria-label={c.name}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-3 pt-5 border-t border-white/[0.075]">
              <span id="appearance-label" className="block font-medium text-white">Appearance</span>
              <div role="radiogroup" aria-labelledby="appearance-label" className="grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-white/[0.06]">
                {appearances.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={settings.appearance === value}
                    onClick={() => setSettings({ ...settings, appearance: value })}
                    className={`h-7 flex items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors ${
                      settings.appearance === value ? 'bg-control text-white shadow-control' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Icon size={13} aria-hidden /> {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Terminal Section */}
        <section className="break-inside-avoid space-y-2.5 mb-6">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <TerminalSquare size={14} aria-hidden className="text-zinc-500" /> Terminal
          </h2>

          <TerminalFontSettings settings={settings} setSettings={setSettings} />

          <TerminalColoursSetting settings={settings} setSettings={setSettings} />

          <TerminalScrollbackSetting settings={settings} setSettings={setSettings} />

          <DefaultShellSetting settings={settings} setSettings={setSettings} />
          
          <ShellConfigSyncSettings servers={servers} />
        </section>

        {/* Not on Android, which has no ssh-agent or ~/.ssh/config to use. */}
        {!IS_ANDROID && (
          <section className="break-inside-avoid space-y-2.5 mb-6">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <KeyRound size={14} aria-hidden className="text-zinc-500" /> Authentication
          </h2>

            <SshAgentSetting settings={settings} setSettings={setSettings} />
            <SshConfigSetting settings={settings} setSettings={setSettings} />
          </section>
        )}

        {IS_ANDROID && (
          <section className="break-inside-avoid space-y-2.5 mb-6">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <EyeOff size={14} aria-hidden className="text-zinc-500" /> Privacy
          </h2>

            <SecureScreenSetting />
          </section>
        )}

        {/* Activity Section — moved out of the sidebar so the top-level
            navigation stays focused on primary workflows. Logs are diagnostic
            only; keeping them one click deep here cleans up the sidebar on
            mobile (six icons → five) without burying the data. */}
        {onOpenLogs && (
          <section className="break-inside-avoid space-y-2.5 mb-6">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <List size={14} aria-hidden className="text-zinc-500" /> Activity
          </h2>

            <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-4">
              <p className="text-zinc-400 leading-[18px]">
                What the app has done this session: connections, transfers, syncs and their errors.
              </p>
              <button
                onClick={onOpenLogs}
                className="btn"
              >
                <List size={14} aria-hidden /> Open activity
              </button>
            </div>
          </section>
        )}

        {/* Cloud Section */}
        <section className="break-inside-avoid space-y-2.5 mb-6">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Cloud size={14} aria-hidden className="text-zinc-500" /> Cloud sync
          </h2>

          <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium text-white">Auto-sync</div>
                <p className="text-[12px] text-zinc-500 leading-[16px] mt-0.5">
                  Keep open profiles synced in the background — shortly after you make a change, when
                  you return to the window, and every few minutes to pull in others' edits on shared
                  profiles. Turn off to sync only with the manual button.
                </p>
              </div>
              <button
                role="switch"
                aria-label="Auto-sync"
                aria-checked={settings.autoSync !== false}
                onClick={() => setSettings((s: any) => ({ ...s, autoSync: !(s.autoSync !== false) }))}
                className={`relative shrink-0 w-9 h-[22px] rounded-full transition-colors shadow-[inset_0_0_0_0.5px_var(--border-strong)] ${settings.autoSync !== false ? 'bg-primary' : 'bg-white/[0.08]'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-snow shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform ${settings.autoSync !== false ? 'translate-x-[14px]' : ''}`} />
              </button>
            </div>

            {settings.autoSync !== false && (
              <div className="border-t border-white/[0.075] pt-4 text-[12px] text-zinc-400">
                Currently checking every{' '}
                <span className="text-zinc-100 font-semibold">{settings.syncIntervalMin ?? 5} min</span>. Change it
                on the Profile tab, next to Sync now.
              </div>
            )}
          </div>
        </section>

        {/* Maintenance Section */}
        <section className="break-inside-avoid space-y-2.5 mb-6">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <RefreshCw size={14} aria-hidden className="text-zinc-500" /> Maintenance
          </h2>

          <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-4 space-y-4">
            {storage && (
              <div className="space-y-1.5 pb-4 border-b border-white/[0.075]">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">Data folder</span>
                  {storage.portable && (
                    <span className="pill bg-primary/[0.12] text-primary">
                      Portable
                    </span>
                  )}
                </div>
                <CopyValue value={storage.data_dir} className="max-w-full text-zinc-300">
                  <span className="font-mono text-[11.5px] break-all select-text">{storage.data_dir}</span>
                </CopyValue>
                {storage.warning && (
                  <p className="text-[11.5px] text-amber-400/90 leading-relaxed">{storage.warning}</p>
                )}
              </div>
            )}
            <p className="text-zinc-400 leading-[18px]">
              Puts the accent colour, appearance and terminal font back to how they came. Nothing else changes.
            </p>
            <button
              onClick={async () => {
                const ok = await confirm({ title: "Reset appearance?", message: "The accent colour, appearance and terminal font go back to their defaults.", okLabel: "Reset" });
                if (ok) setSettings((s: any) => ({ ...s, primaryColor: '', appearance: 'system', terminalFontSize: 14, terminalFontFamily: '' }));
              }}
              className="btn"
            >
              Reset appearance
            </button>
          </div>
        </section>
      </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
