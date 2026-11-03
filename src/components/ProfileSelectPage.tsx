import { Fragment, forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle, ArrowBigUp, ArrowUpCircle, Check, CheckCircle2, ChevronLeft, ChevronRight, Cloud, CloudOff, Download,
  Eye, EyeOff, Fingerprint, Github, HardDrive, Loader2, MoreHorizontal, Plus, RefreshCw, ShieldCheck, Trash2, Upload, X,
} from "lucide-react";
import CloudPanel from "./CloudPanel";
import { CloudConfigView, hostOf } from "./SyncServerSetting";
import BrandMark from "./BrandMark";
import { IS_ANDROID } from "../util/platform";
import { PRIVACY_URL } from "../util/links";
import { useTextPrompt, useConfirm } from "../ui/confirm";
import { forgetProfileBookmarks } from "../util/sftpBookmarks";

// Vault file header (lib.rs VAULT_MAGIC / VAULT_VERSION) — checked up front on
// Android imports so a wrong file fails before the user picks a name.
const VAULT_MAGIC = "OMNV";
const VAULT_VERSION = 1;

// Base64 in 32 KB chunks: spreading a large Uint8Array into one
// String.fromCharCode call would overflow the call stack.
const bytesToBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

interface CloudStatus { signed_in: boolean; email: string | null; }
// One personal profile as reported by the cloud (GET /sync/profiles). Names +
// counts only — the server never sees the encrypted contents. `profile` is the
// partition key (a name for legacy profiles, a UUID for new ones); `name` is the
// human-readable label to show and to restore under.
interface CloudProfile { profile: string; name: string; records: number; live_records: number; last_updated: string; }
// Result of the GitHub release check (backend: about::check_for_updates).
// `has_update` is true only when `latest` is a strictly newer semver than the
// running build.
interface UpdateInfo { current: string; latest: string | null; has_update: boolean; release_url: string | null; }
// The running version and the project's GitHub page (backend: about::app_info).
interface AppInfo { version: string; github_repo_url: string; }
// The GitHub link's fallback, should app_info ever fail (about::GITHUB_REPO).
const REPO_URL = "https://github.com/SinaXhpm/Submarine";

// The picker's unit of display: one profile, wherever it lives. `local` = an
// on-disk vault exists here; `cloud` = the matching cloud partition (or null).
// Merging local + cloud into a single row is what lets the login screen be the
// one place to SEE and MANAGE every profile — open it, export it, remove it
// here, get it from the cloud, or delete it from the cloud.
interface Row { name: string; local: boolean; cloud: CloudProfile | null; }

// What the page is busy with. One action at a time.
type Pending = "unlock" | "quick" | "create" | "import" | "get" | "work";

// The profile opened last on this device is the one picked when the page
// opens. Only its name is kept, which this page shows anyway. Storage can be
// unavailable (blocked, private), so every access is guarded; the first
// profile is picked then.
const LAST_PROFILE_KEY = "submarine-last-profile";
const lastProfile = () => {
  try { return localStorage.getItem(LAST_PROFILE_KEY) ?? ""; } catch { return ""; }
};
const rememberProfile = (name: string) => {
  try { localStorage.setItem(LAST_PROFILE_KEY, name); } catch { /* the first profile is picked instead */ }
};
const forgetLastProfile = (name: string) => {
  try { if (localStorage.getItem(LAST_PROFILE_KEY) === name) localStorage.removeItem(LAST_PROFILE_KEY); } catch { /* nothing kept */ }
};

// Clean the [PREFIX] off backend errors for display.
const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

// The backend's rules for a profile name (lib.rs validate_profile_name),
// checked while it's typed, plus the names already taken. Case doesn't count:
// the list matches names that way, and so do Windows file names.
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;
const nameProblem = (name: string, local: string[], cloud: string[]): string | null => {
  if (!name) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return "Use letters, numbers, - and _ only.";
  if (name.length > 32) return "Use 32 characters at most.";
  if (RESERVED_NAME.test(name)) return `"${name}" is a reserved name on Windows.`;
  const key = name.toLowerCase();
  const here = local.find((p) => p.toLowerCase() === key);
  if (here) return `There's already a profile named "${here}".`;
  // A new profile is a different one, even under the same name: it would sit
  // in the list as if it were the cloud one.
  const there = cloud.find((p) => p.toLowerCase() === key);
  if (there) return `"${there}" is in your cloud. Get it from the list, or pick another name.`;
  return null;
};

// A short side-to-side nudge for a refused entry, skipped when the system asks
// for less motion. The Web Animations API leaves no transform behind.
const shake = (el: HTMLElement | null | undefined) => {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [0, -7, 6, -4, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: 380, easing: "ease-out" },
  );
};

// Whether Caps Lock is on, null until known: a page only learns it from an
// event, so every key and click reads it.
const useCapsLock = () => {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    const read = (e: KeyboardEvent | MouseEvent) => {
      // Some IME and synthetic events come without getModifierState.
      if (typeof e.getModifierState === "function") setOn(e.getModifierState("CapsLock"));
    };
    window.addEventListener("keydown", read, true);
    window.addEventListener("keyup", read, true);
    window.addEventListener("mousedown", read, true);
    return () => {
      window.removeEventListener("keydown", read, true);
      window.removeEventListener("keyup", read, true);
      window.removeEventListener("mousedown", read, true);
    };
  }, []);
  return on;
};

// A box with a problem: the danger colour for its border and focus ring.
const INVALID = "border-danger focus:border-danger focus:ring-danger/25";

interface Props {
  onUnlocked: (profileName: string) => void;
  /** Back here from Lock: quick unlock waits for a click instead of asking
   *  right away, as it does when the app starts. */
  afterLock?: boolean;
}

const ProfileSelectPage = ({ onUnlocked, afterLock = false }: Props) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  // The first load only: a later reload keeps the list on screen.
  const [loading, setLoading] = useState(true);
  // How the last action on a profile went (export, import, remove, get, delete
  // from the cloud), at the top of the page.
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const busy = pending !== null;

  // The open row (by display name). A local row opens to its password box; a
  // cloud-only row to Get.
  const [selected, setSelected] = useState<string>("");
  // The profile list, opened by Switch profile over the unlock screen.
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [password, setPassword] = useState("");
  // Why the last unlock failed, under the password box.
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  // Set by a Create click with something missing: the rules not met yet turn
  // red instead of grey.
  const [triedCreate, setTriedCreate] = useState(false);
  // Why the backend refused the new profile.
  const [createError, setCreateError] = useState<string | null>(null);

  // Import is a two-step flow: pick file (backend validates header) → prompt
  // for the profile name to save it under. We keep the picked path here so
  // the second step can pass it back to Rust on commit.
  // Desktop stages a file path (native dialog); Android stages the file's
  // bytes (base64) read from the system file picker via <input type="file">.
  // `file` is the file's name, to show which one is being imported.
  const [importStaged, setImportStaged] = useState<{ sourcePath?: string; bytesB64?: string; name: string; file: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);

  // Cloud status surfaced directly on this page so the user doesn't have
  // to open the modal just to know if sync is connected or pending.
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>({ signed_in: false, email: null });
  // The sync server's host, shown beside the account when it isn't the default.
  const [cloudHost, setCloudHost] = useState<string | null>(null);
  // Profiles that live in the signed-in cloud account. Merged with the local
  // list below so a fresh device SHOWS the user's profiles instead of making
  // them remember and type a name. Empty until signed in (or on network error).
  const [cloudProfiles, setCloudProfiles] = useState<CloudProfile[]>([]);
  // A click on refresh, while it runs.
  const [refreshing, setRefreshing] = useState(false);
  // The row whose actions menu is open, where to put it, and what to focus
  // when it closes.
  const [menu, setMenu] = useState<{ name: string; place: MenuPlace; from: HTMLElement | null } | null>(null);
  // A newer published release than the running build, if any. Set only when
  // one actually exists, so the notice under the footer appears solely when
  // there's something to announce.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Footer: the version + GitHub link, and how the last "Check for updates"
  // click went.
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "latest" | "none" | "error">("idle");
  const [checkError, setCheckError] = useState("");

  const textPrompt = useTextPrompt();
  const confirm = useConfirm();
  const capsLock = useCapsLock();

  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  // The password box and its button, nudged on a wrong password.
  const unlockFieldRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const newPasswordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);
  const importNameRef = useRef<HTMLInputElement | null>(null);

  // The row to open when none is: the profile opened last here, else the first.
  const pickFrom = (list: string[], prev: string) => {
    if (prev && list.includes(prev)) return prev;
    const last = lastProfile();
    return list.includes(last) ? last : list[0] || "";
  };

  const reload = async () => {
    setError(null);
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
      setSelected((prev) => pickFrom(list, prev));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // Cloud connection + the account's profile list. Best-effort: a network
  // failure must never block unlocking a local profile, so errors just leave
  // the cloud side empty. A click on refresh (`manual`) says what went wrong.
  const refreshCloud = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const s = await invoke<CloudStatus>("cloud_status");
      setCloudStatus(s);
      if (s.signed_in) {
        invoke<CloudConfigView>("cloud_get_config")
          .then((v) => setCloudHost(v.is_custom ? hostOf(v.server) : null))
          .catch(() => setCloudHost(null));
        try {
          const cps = await invoke<CloudProfile[]>("cloud_list_sync_profiles");
          // Hide empty / retired partitions (all-tombstone or escrow-only) —
          // they'd just be noise in the picker.
          setCloudProfiles(cps.filter((c) => c.live_records > 0));
        } catch (e) {
          setCloudProfiles([]);
          if (manual) setError(`Couldn't load your cloud profiles: ${cleanErr(e)}`);
        }
      } else {
        setCloudProfiles([]);
      }
    } catch (e) {
      // The panel can still be opened to retry.
      if (manual) setError(`Couldn't reach the cloud: ${cleanErr(e)}`);
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => { refreshCloud(); }, [refreshCloud]);

  // Check GitHub for a newer release once per app open (this page mounts on
  // launch and on every return to the picker). Best-effort and silent: the
  // fetch+semver-compare happens in Rust (about::check_for_updates), and any
  // failure — offline, rate-limited, no releases — simply shows nothing.
  useEffect(() => {
    invoke<UpdateInfo>("check_for_updates")
      .then((u) => { if (u.has_update && u.latest) setUpdate(u); })
      .catch(() => {});
  }, []);

  // A link that can't be opened (no browser / URL handler on this device)
  // says so under the footer row instead of doing nothing.
  const [linkError, setLinkError] = useState("");
  const openLink = (url: string) => {
    setLinkError("");
    invoke("open_external_url", { url }).catch((e) => setLinkError(`Couldn't open the link: ${cleanErr(e)}`));
  };

  const openReleaseNotes = () => {
    if (update?.release_url) openLink(update.release_url);
  };

  useEffect(() => {
    invoke<AppInfo>("app_info").then(setAppInfo).catch(() => {});
  }, []);

  const openRepo = () => openLink(appInfo?.github_repo_url ?? REPO_URL);

  // The footer's "Check for updates". Unlike the silent check above it reports
  // every outcome; a newer release lands in `update`, so the same notice
  // announces it.
  const checkForUpdates = async () => {
    if (check === "checking") return;
    setCheck("checking");
    try {
      const u = await invoke<UpdateInfo>("check_for_updates");
      if (u.has_update && u.latest) {
        setUpdate(u);
        setCheck("idle");
      } else {
        setCheck(u.latest ? "latest" : "none");
      }
    } catch (e) {
      setCheckError(cleanErr(e));
      setCheck("error");
    }
  };

  // When the open row changes, reset + focus the password so opening a
  // profile is always "click row, type, Enter". The new row's box also starts
  // with its password hidden.
  useEffect(() => {
    setPassword("");
    setUnlockError(null);
    setError(null);
    requestAnimationFrame(() => passwordInputRef.current?.focus());
  }, [selected]);

  // Quick unlock (#166, quick_unlock.rs): this profile opens with Windows
  // Hello, Touch ID or the fingerprint on this device, if the user turned that on. The
  // app starting on the profile used last asks for it right away, once;
  // closing that prompt leaves the password.
  const [quick, setQuick] = useState<{ name: string; method: string } | null>(null);
  const autoQuickTried = useRef(afterLock);
  useEffect(() => {
    let live = true;
    const name = selected;
    setQuick(null);
    if (!name) return;
    (async () => {
      try {
        const support = await invoke<{ method: string | null; ready: boolean }>("quick_unlock_support");
        if (!support.method || !support.ready) return;
        const on = await invoke<boolean>("quick_unlock_status", { name });
        if (!live || !on) return;
        setQuick({ name, method: support.method });
        if (!autoQuickTried.current && name === lastProfile()) {
          autoQuickTried.current = true;
          void quickUnlock(name);
        }
      } catch { /* the password still works */ }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const quickMethodName = (method?: string) =>
    method === "android-biometric" ? "fingerprint" : method === "macos-touch-id" ? "Touch ID" : "Windows Hello";
  const quickLabel = `Unlock with ${quickMethodName(quick?.method)}`;
  const quickUnlock = async (name: string) => {
    if (busy) return;
    autoQuickTried.current = true;
    setPending("quick"); setUnlockError(null);
    try {
      await invoke("quick_unlock", { name });
    } catch (e) {
      const raw = String(e);
      setPending(null);
      if (raw.includes("[QUICK_UNLOCK] CANCELLED")) {
        requestAnimationFrame(() => passwordInputRef.current?.focus());
        return;
      }
      if (raw.includes("[QUICK_UNLOCK] STALE")) {
        setQuick(null);
        setUnlockError("Quick unlock no longer fits this profile here. Unlock with the password, then turn it on again.");
      } else {
        setUnlockError(cleanErr(e));
      }
      requestAnimationFrame(() => passwordInputRef.current?.focus());
      return;
    }
    rememberProfile(name);
    onUnlocked(name);
  };

  // Merge local + cloud into one ordered list, matched case-insensitively by
  // display name (a local file and its cloud partition are the SAME profile
  // even though the partition key may be an opaque UUID). Local-first, then
  // alphabetical, so the profiles already on this device sit up top.
  const buildRows = (): Row[] => {
    const byKey = new Map<string, Row>();
    for (const p of profiles) byKey.set(p.toLowerCase(), { name: p, local: true, cloud: null });
    for (const c of cloudProfiles) {
      const k = c.name.toLowerCase();
      const existing = byKey.get(k);
      if (existing) existing.cloud = c;
      else byKey.set(k, { name: c.name, local: false, cloud: c });
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.local !== b.local ? (a.local ? -1 : 1) : a.name.localeCompare(b.name)
    );
  };
  const rows = buildRows();

  // First run (nothing anywhere) drops straight into create; a returning user
  // on a fresh device (cloud profiles, no local) still sees the list so they
  // can Get them. `creating` is the explicit "New profile" toggle.
  const firstRun = !loading && rows.length === 0;
  const showCreate = creating || firstRun;

  // Each view focuses its first box: the name in the form, the password in
  // the list.
  useEffect(() => {
    requestAnimationFrame(() => (showCreate ? nameInputRef : passwordInputRef).current?.focus());
  }, [showCreate]);

  // A profile on this device goes to its unlock screen; one in the cloud only
  // opens to Get.
  const pick = (row: Row) => {
    setSelected(row.name);
    if (row.local) {
      setListOpen(false);
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    }
  };

  const openCreate = () => {
    setCreating(true);
    setPassword(""); setUnlockError(null); setError(null); setInfo(null);
  };

  // Leaving the form forgets what was typed in it, passwords included.
  const closeCreate = () => {
    setCreating(false);
    setNewName(""); setNewPassword(""); setNewConfirmPassword("");
    setTriedCreate(false); setCreateError(null); setError(null);
  };

  const unlockSelected = async () => {
    const name = selected;
    if (!name || !password || busy) return;
    setPending("unlock"); setUnlockError(null);
    try {
      await invoke("select_profile", { name });
      await invoke("setup_master_db", { password });
    } catch (e) {
      const raw = String(e);
      setUnlockError(raw.toLowerCase().includes("decrypt") ? "Wrong password." : cleanErr(e));
      setPending(null);
      shake(unlockFieldRef.current);
      // Selected, so the next try types over it.
      requestAnimationFrame(() => {
        const el = passwordInputRef.current;
        el?.focus();
        el?.select();
      });
      return;
    }
    // No reset after this: the page goes away, and the button stays busy
    // until it does.
    rememberProfile(name);
    onUnlocked(name);
  };

  // The create form's checks, live. Length counts characters the way the
  // backend does (code points, not UTF-16 units).
  const nameIssue = nameProblem(newName.trim(), profiles, cloudProfiles.map((c) => c.name));
  const nameHint = nameIssue ?? (triedCreate && !newName.trim() ? "Give the profile a name." : null);
  const longEnough = [...newPassword].length >= 8;
  const matches = newConfirmPassword.length > 0 && newPassword === newConfirmPassword;
  const createReady = !!newName.trim() && !nameIssue && longEnough && matches;

  // Enter in the name or the first password box moves on to the next box,
  // until everything's filled in; then it creates the profile.
  const advance = (e: React.KeyboardEvent<HTMLInputElement>, next: React.RefObject<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || createReady) return;
    e.preventDefault();
    next.current?.focus();
  };

  const createNew = async () => {
    if (busy) return;
    const name = newName.trim();
    if (!createReady) {
      setTriedCreate(true);
      // To the first thing still missing.
      const el = !name || nameIssue ? nameInputRef.current : !longEnough ? newPasswordRef.current : confirmRef.current;
      el?.focus();
      shake(el === nameInputRef.current ? el : el?.parentElement);
      return;
    }
    setPending("create"); setCreateError(null);
    try {
      await invoke("create_profile", { name, password: newPassword });
    } catch (e) {
      setCreateError(cleanErr(e));
      setPending(null);
      return;
    }
    rememberProfile(name);
    onUnlocked(name);
  };

  const exportProfile = async (name: string) => {
    if (busy) return;
    setPending("work"); setError(null); setInfo(null);
    try {
      // Returns the chosen path on success (on Android, the saved file's
      // name: the system picker doesn't say where it is), null if the user
      // cancelled the save dialog. We only surface a toast in the success case.
      const saved = await invoke<string | null>("export_profile", { name });
      if (saved) setInfo(IS_ANDROID ? `Saved as ${saved}` : `Exported to ${saved}`);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  const focusImportName = () => requestAnimationFrame(() => {
    const el = importNameRef.current;
    el?.focus();
    el?.select();
  });

  const startImport = async () => {
    if (busy) return;
    setError(null); setInfo(null);
    // Android: no native dialog — the WebView's file input opens the system
    // picker (Downloads, Drive, messengers…) and hands us the file.
    if (IS_ANDROID) { importFileRef.current?.click(); return; }
    setPending("work");
    try {
      const picked = await invoke<[string, string] | null>("import_profile_pick");
      if (picked) {
        const [sourcePath, suggested] = picked;
        setImportStaged({ sourcePath, name: suggested, file: sourcePath.split(/[\\/]/).pop() || sourcePath });
        focusImportName();
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  const onImportFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again later
    if (!file) return;
    setError(null); setInfo(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Same quick header check the backend does, for instant feedback.
      if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 4)) !== VAULT_MAGIC || bytes[4] !== VAULT_VERSION) {
        setError("That file isn't a Supermarine profile.");
        return;
      }
      const suggested = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "imported";
      setImportStaged({ bytesB64: bytesToBase64(bytes), name: suggested, file: file.name });
      focusImportName();
    } catch (err) {
      setError(cleanErr(err));
    }
  };

  // An imported file is a profile of its own, so only names on this device
  // are taken; the cloud one of the same name may well be this very profile.
  const importIssue = importStaged ? nameProblem(importStaged.name.trim(), profiles, []) : null;

  const cancelImport = () => { setImportStaged(null); setError(null); };

  const commitImport = async () => {
    if (!importStaged || busy) return;
    const name = importStaged.name.trim();
    if (!name || importIssue) { importNameRef.current?.focus(); shake(importNameRef.current); return; }
    setPending("import"); setError(null);
    try {
      if (importStaged.bytesB64) {
        await invoke("import_profile_bytes", { name, data: importStaged.bytesB64 });
      } else {
        await invoke("import_profile_save", { sourcePath: importStaged.sourcePath, name });
      }
      setImportStaged(null);
      closeCreate();
      setInfo(`Imported as "${name}". Unlock it with its original password.`);
      await reload();
      setSelected(name);
      setListOpen(false);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  // Remove the on-disk copy. If the profile is also in the cloud, it stays
  // there and can be pulled back with its password; if not, it's gone for good
  // — the confirm wording says which.
  const removeLocal = async (name: string) => {
    if (busy) return;
    const inCloud = cloudProfiles.some((c) => c.name.toLowerCase() === name.toLowerCase());
    const ok = await confirm({
      title: "Remove from this device",
      message: inCloud
        ? `Remove "${name}" from this device?\n\nThe encrypted file here is deleted. It stays in your cloud — you can Get it again anytime with its password.`
        : `Remove "${name}" from this device?\n\nThe encrypted file here is deleted. This profile is not in your cloud, so it will be gone for good.`,
      destructive: true,
      okLabel: "Remove",
    });
    if (!ok) return;
    setPending("work"); setError(null); setInfo(null);
    try {
      await invoke("delete_profile", { name });
      forgetProfileBookmarks(name);
      forgetLastProfile(name);
      await reload();
      refreshCloud();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  // Owner-only hard delete of the cloud copy (the /sync store is per-account, so
  // you can only ever delete your own). Local copies are untouched.
  const deleteFromCloud = async (row: Row) => {
    if (!row.cloud || busy) return;
    const ok = await confirm({
      title: "Delete from cloud",
      message: `Delete "${row.name}" from your cloud?\n\nThis erases its synced copy and its restore key from the cloud. Copies already on your devices are NOT touched. This can't be undone.`,
      destructive: true,
      okLabel: "Delete from cloud",
    });
    if (!ok) return;
    setPending("work"); setError(null); setInfo(null);
    try {
      const n = await invoke<number>("cloud_delete_profile", { profile: row.cloud.profile });
      setInfo(`Removed "${row.name}" from the cloud (${n} record${n === 1 ? "" : "s"}).`);
      // A cloud-only row is gone with it: open a local one instead.
      if (!row.local) setSelected((prev) => (prev === row.name ? pickFrom(profiles, "") : prev));
      await refreshCloud();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  // Bring a cloud profile onto this device using nothing but its own password:
  // that password unseals the cloud copy's key AND protects the copy saved
  // here. One field, no separate recovery secret. Taken exactly as typed, as
  // the unlock box takes it: a space at either end is part of the password.
  const bringDown = async (c: CloudProfile) => {
    if (busy) return;
    setError(null); setInfo(null);
    const pw = await textPrompt({
      title: `Get "${c.name}"`,
      message: "Enter THIS profile's password — the same one you open it with. It unlocks the cloud copy and protects the copy saved on this device.",
      placeholder: "Profile password",
      password: true,
      keepWhitespace: true,
      okLabel: "Get it",
      validate: (v: string) => (v.length < 1 ? "Enter the password" : null),
    });
    if (pw === null) return;
    setPending("get");
    try {
      const rep = await invoke<{ pushed: number; pulled: number }>("restore_personal_profile", {
        cloudProfile: c.profile, localName: c.name, vaultPassword: pw,
      });
      setInfo(`"${c.name}" is now on this device, with ${rep.pulled} item${rep.pulled === 1 ? "" : "s"}. Unlock it with the same password.`);
      await reload();
      setSelected(c.name);
      setListOpen(false);
      refreshCloud();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setPending(null);
    }
  };

  // A row's actions, in its ⋯ menu. The ones that ask first end in "…".
  const menuItems = (row: Row): MenuItem[] => {
    const items: MenuItem[] = [];
    if (row.local) {
      items.push({ label: "Export…", icon: <Download size={14} />, onSelect: () => exportProfile(row.name) });
      items.push({ label: "Remove from this device…", icon: <Trash2 size={14} />, danger: true, onSelect: () => removeLocal(row.name) });
    } else if (row.cloud) {
      const c = row.cloud;
      items.push({ label: "Get on this device…", icon: <Download size={14} />, onSelect: () => bringDown(c) });
    }
    if (row.cloud) items.push({ label: "Delete from cloud…", icon: <CloudOff size={14} />, danger: true, onSelect: () => deleteFromCloud(row) });
    return items;
  };
  const menuRow = menu ? rows.find((r) => r.name === menu.name) : undefined;

  const closeMenu = (refocus: boolean) => {
    const from = menu?.from;
    setMenu(null);
    if (refocus) from?.focus();
  };

  // What the footer's update item shows for each outcome of the manual check.
  const checkItem = {
    idle: { label: "Check for updates", icon: <RefreshCw size={12} />, tone: undefined },
    checking: { label: "Checking…", icon: <RefreshCw size={12} className="animate-spin" />, tone: undefined },
    latest: { label: "Up to date", icon: <CheckCircle2 size={12} />, tone: "text-emerald-400/90 hover:text-emerald-300" },
    none: { label: "No releases yet", icon: <RefreshCw size={12} />, tone: undefined },
    error: { label: "Couldn't check", icon: <AlertTriangle size={12} />, tone: "text-amber-400/90 hover:text-amber-300" },
  }[check];

  const selectedRow = rows.find((r) => r.name === selected);
  // The focused unlock screen, unless the list is asked for or the profile
  // picked isn't on this device.
  const view: "loading" | "create" | "unlock" | "profiles" =
    loading ? "loading" : showCreate ? "create" : selectedRow?.local && !listOpen ? "unlock" : "profiles";
  const canGoBack = profiles.length > 0;

  const openList = () => {
    setListOpen(true);
    setUnlockError(null);
    setError(null); setInfo(null);
    requestAnimationFrame(() => {
      const list = listRef.current;
      (list?.querySelector<HTMLElement>("[aria-current=true]") ?? list?.querySelector<HTMLElement>("button"))?.focus();
    });
  };
  const closeList = () => {
    if (!canGoBack) return;
    // From a cloud row, back to the profile on this device it came from.
    setSelected((prev) => (profiles.includes(prev) ? prev : pickFrom(profiles, "")));
    setListOpen(false);
    requestAnimationFrame(() => passwordInputRef.current?.focus());
  };

  const quickName = quick?.method === "android-biometric" ? "your fingerprint" : quickMethodName(quick?.method);

  return (
    // Scrolls when the content is taller than the screen (phones with the
    // keyboard open); `m-auto` still centres it when there's room: plain
    // items-center would clip the top out of reach instead.
    <div className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col px-4 sm:px-6 pt-14 pb-4 bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {[1100, 760, 420].map((d, i) => (
          <span
            key={d}
            className="absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: d, height: d, marginLeft: -d / 2, marginTop: -d / 2,
              boxShadow: `inset 0 0 0 0.5px var(${i === 2 ? "--border" : "--border-strong"})`,
            }}
          />
        ))}
      </div>
      <input
        ref={importFileRef}
        type="file"
        className="hidden"
        onChange={onImportFilePicked}
      />
      <main className="relative w-full max-w-[360px] m-auto flex flex-col">
        <header className="flex flex-col items-center text-center select-none">
          <div className="relative grid h-28 w-28 place-items-center">
            {view === "unlock" && (
              <>
                <span aria-hidden className="absolute inset-0 rounded-full border border-primary animate-sonar motion-reduce:hidden" />
                <span aria-hidden className="absolute inset-0 rounded-full border border-primary animate-sonar [animation-delay:1.6s] motion-reduce:hidden" />
              </>
            )}
            <BrandMark className="relative h-[84px] w-[84px]" />
          </div>
          {view === "unlock" ? (
            <>
              <h1 className="mt-6 text-[22px] font-[650] leading-7 text-white">Supermarine is locked</h1>
              <p className="mt-1.5 text-muted [text-wrap:balance]">
                {quick?.name === selected ? `Use ${quickName} or enter` : "Enter"} the password for the{" "}
                <strong className="font-semibold text-white break-all">{selected}</strong> profile.
              </p>
            </>
          ) : view === "create" ? (
            <>
              <h1 className="mt-6 text-[22px] font-[650] leading-7 text-white">
                {firstRun ? "Welcome to Supermarine" : "New profile"}
              </h1>
              <p className="mt-1.5 text-muted">
                {firstRun ? "Create a profile to keep your servers, logins and keys in." : "A separate vault with its own password."}
              </p>
            </>
          ) : (
            <h1 className="mt-6 text-[22px] font-[650] leading-7 text-white">
              {view === "loading" ? "Supermarine" : "Choose a profile"}
            </h1>
          )}
        </header>

        <div className="mt-5">
          {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
          {/* Wraps instead of truncating: an Android export path is long and
              the user needs all of it to find the file. */}
          {info && !error && <Banner tone="info" onClose={() => setInfo(null)}>{info}</Banner>}
        </div>

        {importStaged && (
          <form
            noValidate
            onSubmit={(e) => { e.preventDefault(); commitImport(); }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && pending !== "import") { e.preventDefault(); e.stopPropagation(); cancelImport(); }
            }}
            className="tile mb-3 p-4 text-left animate-in"
          >
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
              <Upload size={14} aria-hidden className="shrink-0 text-primary" /> Import a profile
            </h2>
            <p className="mt-1 break-words text-[12px] leading-snug text-muted">
              From {importStaged.file}. Pick a name for it; its password stays the same.
            </p>
            <label htmlFor="import-name" className="sr-only">Name for the imported profile</label>
            <input
              id="import-name"
              ref={importNameRef}
              value={importStaged.name}
              onChange={(e) => { const name = e.target.value; setImportStaged((s) => s && { ...s, name }); }}
              placeholder="Profile name"
              aria-invalid={importIssue ? true : undefined}
              aria-describedby={importIssue ? "import-name-hint" : undefined}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={32}
              className={`field mt-3 h-9 ${importIssue ? INVALID : ""}`}
            />
            {importIssue && <Hint id="import-name-hint" tone="error">{importIssue}</Hint>}
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={busy || !importStaged.name.trim() || !!importIssue}
                className="btn btn-primary h-9 flex-1"
              >
                {pending === "import" ? <><Loader2 size={14} aria-hidden className="animate-spin" /> Importing…</> : "Import"}
              </button>
              <button type="button" onClick={cancelImport} disabled={pending === "import"} className="btn h-9 px-4">
                Cancel
              </button>
            </div>
          </form>
        )}

        {view === "loading" ? (
          <div aria-busy="true" aria-label="Loading profiles" className="flex h-[34px] gap-2 animate-pulse">
            <span className="flex-1 rounded-md bg-white/[0.06]" />
            <span className="w-11 rounded-md bg-white/[0.06]" />
          </div>
        ) : view === "unlock" ? (
          <form
            onSubmit={(e) => { e.preventDefault(); unlockSelected(); }}
            aria-busy={pending === "unlock"}
            className="flex flex-col items-center"
          >
            <div ref={unlockFieldRef} className="flex w-full gap-2">
              <PasswordInput
                ref={passwordInputRef}
                value={password}
                onChange={(v) => { setPassword(v); setUnlockError(null); }}
                onKeyDown={(e) => {
                  // Escape clears a typed password.
                  if (e.key === "Escape" && password) {
                    e.preventDefault(); e.stopPropagation();
                    setPassword(""); setUnlockError(null);
                  }
                }}
                label="Password"
                autoComplete="current-password"
                enterKeyHint="go"
                invalid={!!unlockError}
                readOnly={pending === "unlock"}
                describedBy="unlock-hint"
              />
              <button
                type="submit"
                disabled={busy || !password}
                aria-label="Unlock"
                title="Unlock"
                className="btn btn-primary h-11 w-11 shrink-0 px-0 sm:h-[34px] sm:w-10 disabled:opacity-60"
              >
                {pending === "unlock" ? <Loader2 size={15} aria-hidden className="animate-spin" /> : <ChevronRight size={16} aria-hidden />}
              </button>
            </div>
            <div id="unlock-hint" aria-live="polite" className="w-full">
              {unlockError && <Hint tone="error">{unlockError}</Hint>}
            </div>
            <div className="mt-3 flex w-full items-center justify-between gap-3 text-[12px]">
              <button
                type="button"
                onClick={openList}
                disabled={busy}
                className="-mx-1.5 h-7 rounded-md px-1.5 text-primary transition-colors hover:text-white disabled:opacity-40"
              >
                Switch profile
              </button>
              {capsLock !== null && (
                <span className={capsLock ? "text-warning" : "text-subtle"}>
                  Caps Lock is {capsLock ? "on" : "off"}
                </span>
              )}
            </div>
            {quick?.name === selected && (
              <button
                type="button"
                onClick={() => void quickUnlock(selected)}
                disabled={busy}
                className="btn mt-5 h-9 gap-2 px-4"
              >
                {pending === "quick"
                  ? <Loader2 size={16} aria-hidden className="animate-spin" />
                  : <Fingerprint size={16} aria-hidden className="text-primary" />}
                {quickLabel}
              </button>
            )}
            <p className="mt-10 text-center text-[12px] leading-4 text-subtle [text-wrap:balance]">
              <ShieldCheck size={13} aria-hidden className="mr-1.5 inline-block align-[-2px]" />
              Vault encrypted with <span className="whitespace-nowrap">AES-256-GCM</span>. Its password can't be recovered.
            </p>
          </form>
        ) : view === "create" ? (
          <form
            noValidate
            onSubmit={(e) => { e.preventDefault(); createNew(); }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !firstRun && !busy) { e.preventDefault(); e.stopPropagation(); closeCreate(); }
            }}
            className="tile p-4 text-left animate-in"
          >
            <div className="space-y-2.5">
              <div>
                <label htmlFor="new-name" className="mb-1 block text-[12px] text-muted">Profile name</label>
                <input
                  id="new-name"
                  ref={nameInputRef}
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                  onKeyDown={(e) => advance(e, newPasswordRef)}
                  placeholder="Work"
                  aria-invalid={nameHint ? true : undefined}
                  aria-describedby={nameHint ? "new-name-hint" : undefined}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  maxLength={32}
                  className={`field h-9 ${nameHint ? INVALID : ""}`}
                />
                {nameHint && <Hint id="new-name-hint" tone="error">{nameHint}</Hint>}
              </div>
              <PasswordInput
                ref={newPasswordRef}
                value={newPassword}
                onChange={(v) => { setNewPassword(v); setCreateError(null); }}
                onKeyDown={(e) => advance(e, confirmRef)}
                label="Password"
                showLabel
                autoComplete="new-password"
                enterKeyHint="next"
                invalid={triedCreate && !longEnough}
              />
              <PasswordInput
                ref={confirmRef}
                value={newConfirmPassword}
                onChange={(v) => { setNewConfirmPassword(v); setCreateError(null); }}
                label="Confirm password"
                showLabel
                autoComplete="new-password"
                enterKeyHint="go"
                invalid={triedCreate && longEnough && !matches}
              />
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
              <Rule ok={longEnough} strict={triedCreate}>At least 8 characters</Rule>
              <Rule ok={matches} strict={triedCreate}>Both passwords match</Rule>
            </ul>
            <div aria-live="polite">
              {createError ? <Hint tone="error">{createError}</Hint> : capsLock ? <Hint tone="warn">Caps Lock is on</Hint> : null}
            </div>
            <p className="mt-3 text-[12px] leading-4 text-subtle">The password can't be recovered. Keep it somewhere safe.</p>
            <button type="submit" disabled={busy} className="btn btn-primary mt-4 h-9 w-full">
              {pending === "create" ? <><Loader2 size={14} aria-hidden className="animate-spin" /> Creating…</> : "Create profile"}
            </button>
            <div className="mt-2 flex items-center justify-center gap-1 text-[12px]">
              {!firstRun && (
                <>
                  <button type="button" onClick={closeCreate} disabled={busy} className="btn btn-ghost btn-sm">Cancel</button>
                  <span aria-hidden className="text-subtle">·</span>
                </>
              )}
              <button
                type="button"
                onClick={startImport}
                disabled={busy}
                title="Import an exported .submarine file"
                className="btn btn-ghost btn-sm"
              >
                <Upload size={13} aria-hidden /> Import a file
              </button>
            </div>
          </form>
        ) : (
          /* ---- Every profile, here and in the cloud ---- */
          <section
            aria-label="Profiles"
            className="text-left"
            onKeyDown={(e) => {
              if (e.key === "Escape" && canGoBack && !menu) { e.preventDefault(); e.stopPropagation(); closeList(); }
            }}
          >
            <div className="mb-2 flex h-7 items-center justify-between">
              {canGoBack ? (
                <button type="button" onClick={closeList} disabled={busy} className="btn btn-ghost btn-sm -ml-2.5">
                  <ChevronLeft size={14} aria-hidden /> Back
                </button>
              ) : <span />}
              {cloudStatus.signed_in && (
                <button
                  type="button"
                  onClick={() => refreshCloud(true)}
                  disabled={busy || refreshing}
                  title="Refresh from cloud"
                  aria-label="Refresh from cloud"
                  className="icon-btn"
                >
                  <RefreshCw size={13} aria-hidden className={refreshing ? "animate-spin" : ""} />
                </button>
              )}
            </div>

            <ul ref={listRef} className="tile divide-y divide-white/[0.075] overflow-hidden">
              {rows.map((row) => {
                const current = row.name === selected;
                const open = current && !row.local;
                return (
                  <li key={row.name}>
                    <div
                      className={`flex items-center transition-colors ${current ? "bg-primary/[0.08]" : "hover:bg-white/[0.04]"}`}
                      // Right-click: the same actions as ⋯, at the pointer.
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (busy) return;
                        setMenu({
                          name: row.name,
                          place: { x: e.clientX, top: e.clientY, bottom: e.clientY, end: false },
                          from: e.currentTarget.querySelector("button"),
                        });
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => pick(row)}
                        disabled={busy}
                        aria-current={current && row.local ? true : undefined}
                        aria-expanded={row.local ? undefined : open}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
                      >
                        <Avatar name={row.name} local={row.local} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium leading-5 text-white">{row.name}</span>
                          <RowStatus row={row} />
                        </span>
                        {current && row.local && <Check size={15} aria-hidden className="shrink-0 text-primary" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setMenu({ name: row.name, place: { x: r.right, top: r.top, bottom: r.bottom, end: true }, from: e.currentTarget });
                        }}
                        disabled={busy}
                        aria-haspopup="menu"
                        aria-expanded={menu?.name === row.name}
                        aria-label={`Actions for ${row.name}`}
                        title="More actions"
                        className="icon-btn mr-2 h-8 w-8"
                      >
                        <MoreHorizontal size={16} aria-hidden />
                      </button>
                    </div>

                    {open && (
                      <div className="space-y-2.5 px-3 pb-3">
                        <p className="text-[12px] leading-snug text-muted">
                          Not on this device yet. Get it with this profile's password.
                        </p>
                        <button
                          type="button"
                          onClick={() => row.cloud && bringDown(row.cloud)}
                          disabled={busy}
                          className="btn btn-primary h-9 w-full"
                        >
                          {pending === "get" ? <Loader2 size={14} aria-hidden className="animate-spin" /> : <Download size={14} aria-hidden />} Get on this device
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={openCreate} disabled={busy} className="btn h-9">
                <Plus size={14} aria-hidden /> New profile
              </button>
              <button
                type="button"
                onClick={startImport}
                disabled={busy}
                title="Import an exported .submarine file"
                className="btn h-9"
              >
                <Upload size={14} aria-hidden /> Import
              </button>
            </div>
          </section>
        )}

        {/* Cloud status: with the profiles, where a returning user on a new
            device finds theirs. The unlock screen stays on the password. */}
        {(view === "profiles" || (view === "create" && firstRun)) && (
          <CloudBar status={cloudStatus} host={cloudHost} busy={busy} firstRun={firstRun} onManage={() => setCloudOpen(true)} />
        )}
      </main>

      {/* GitHub, the update check and the running version side by side,
          with a live "new version" notice underneath when one is available
          (the check steps aside then: the notice says it all). */}
      <footer className="relative mt-8 flex flex-col items-center gap-2">
        <div aria-live="polite" className="flex flex-wrap items-center justify-center gap-1 text-[12px]">
          <FooterButton onClick={openRepo} title="Open Supermarine on GitHub" icon={<Github size={12} aria-hidden />} label="GitHub" />
          <FooterDot />
          <FooterButton onClick={() => openLink(PRIVACY_URL)} title="What Supermarine stores and sends: the privacy policy" icon={<ShieldCheck size={12} aria-hidden />} label="Privacy" />
          {!update && (
            <>
              <FooterDot />
              <FooterButton
                onClick={checkForUpdates}
                disabled={check === "checking"}
                title={check === "error" ? `Couldn't reach GitHub: ${checkError}` : "Look for a newer release on GitHub"}
                icon={checkItem.icon}
                label={checkItem.label}
                tone={checkItem.tone}
              />
            </>
          )}
          {appInfo && (
            <>
              <FooterDot />
              <span className="px-1.5 font-mono text-[11px] text-subtle select-text">v{appInfo.version}</span>
            </>
          )}
        </div>
        {/* Why a check or a link failed, as text, since a phone can't
            hover the tooltip. */}
        {(linkError || (check === "error" && checkError)) && (
          <p role="status" className="max-w-[320px] text-center text-[11px] leading-snug text-warning break-words">
            {linkError || `Couldn't reach GitHub: ${checkError}`}
          </p>
        )}
        {update?.has_update && update.latest && (
          <button
            type="button"
            onClick={openReleaseNotes}
            title="Open the release notes on GitHub"
            className="pill bg-primary/[0.12] text-primary transition-colors hover:bg-primary/20"
          >
            <ArrowUpCircle size={12} aria-hidden className="shrink-0" />
            <span>Version <span className="font-mono font-semibold">{update.latest}</span> is out</span>
          </button>
        )}
      </footer>

      {menu && menuRow && (
        <RowMenu
          label={`Actions for ${menuRow.name}`}
          items={menuItems(menuRow)}
          place={menu.place}
          onClose={closeMenu}
        />
      )}

      <CloudPanel
        isOpen={cloudOpen}
        onClose={() => {
          setCloudOpen(false);
          // The modal may have logged in/out or changed cloud state:
          // re-pull so the bar (and profile list) reflects reality.
          refreshCloud();
        }}
        onLocalProfilesChanged={reload}
      />
    </div>
  );
};

// Each profile gets a steady colour from its name, to tell them apart at a
// glance. Full class names, so Tailwind sees them.
const AVATAR_TONES = [
  "bg-sky-500/15 text-sky-300",
  "bg-violet-500/15 text-violet-300",
  "bg-emerald-500/15 text-emerald-300",
  "bg-amber-500/15 text-amber-300",
  "bg-rose-500/15 text-rose-300",
  "bg-cyan-500/15 text-cyan-300",
  "bg-fuchsia-500/15 text-fuchsia-300",
  "bg-lime-500/15 text-lime-300",
];
const avatarTone = (name: string) => {
  let h = 0;
  for (const ch of Array.from(name.toLowerCase())) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
};

// The profile's initial. A cloud-only profile gets a dashed outline instead:
// it isn't on this device yet.
const Avatar = ({ name, local }: { name: string; local: boolean }) => (
  <span
    aria-hidden
    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[14px] font-semibold ${
      local ? avatarTone(name) : "border border-dashed border-zinc-600 text-muted"
    }`}
  >
    {(Array.from(name)[0] ?? "?").toUpperCase()}
  </span>
);

// Where a profile lives, under its name.
const RowStatus = ({ row }: { row: Row }) => {
  if (!row.local) {
    const n = row.cloud?.live_records ?? 0;
    return (
      <span className="flex items-center gap-1 text-[12px] leading-4 text-primary">
        <Cloud size={11} aria-hidden className="shrink-0" />
        <span className="truncate">In your cloud, {n} item{n === 1 ? "" : "s"}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[12px] leading-4 text-subtle">
      <HardDrive size={11} aria-hidden className="shrink-0" />
      <span className="truncate">On this device</span>
      {row.cloud && (
        <>
          <span aria-hidden>·</span>
          <Cloud size={11} aria-hidden className="shrink-0 text-success" />
          <span className="text-success">Synced</span>
        </>
      )}
    </span>
  );
};

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** A visible label above the box; otherwise it's for screen readers and the
   *  placeholder says it. */
  showLabel?: boolean;
  autoComplete: "current-password" | "new-password";
  enterKeyHint: "go" | "next";
  invalid?: boolean;
  readOnly?: boolean;
  describedBy?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

// A password box with a show / hide toggle, hidden at first. Shown or not, it
// stays out of spell check, autocorrect and the keyboard's word learning, so a
// visible password isn't kept as a word.
const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ value, onChange, label, showLabel, autoComplete, enterKeyHint, invalid = false, readOnly, describedBy, onKeyDown }, ref) => {
    const [shown, setShown] = useState(false);
    const id = useId();
    return (
      // min-w-0: an <input> won't shrink below its intrinsic ~20ch width by
      // default, which pushed the button beside it out on phones.
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={showLabel ? "mb-1 block text-[12px] text-muted" : "sr-only"}>{label}</label>
        <div className="relative">
          <input
            id={id}
            ref={ref}
            type={shown ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={showLabel ? undefined : label}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint={enterKeyHint}
            readOnly={readOnly}
            className={`field pr-9 read-only:opacity-70 ${showLabel ? "h-9" : "h-11 text-[14px] sm:h-[34px]"} ${invalid ? INVALID : ""}`}
          />
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            // Keeps the focus, and the caret, in the box.
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Show password"
            aria-pressed={shown}
            title={shown ? "Hide password" : "Show password"}
            className="icon-btn absolute right-1 top-1/2 -translate-y-1/2"
          >
            {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          </button>
        </div>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

// A line under a box: a problem, or a warning such as Caps Lock.
const Hint = ({ id, tone, children }: { id?: string; tone: "error" | "warn"; children: React.ReactNode }) => (
  <p
    id={id}
    className={`mt-2 flex items-start gap-1.5 text-left text-[12px] leading-4 ${tone === "error" ? "text-danger" : "text-warning"}`}
  >
    {tone === "error"
      ? <AlertTriangle size={13} aria-hidden className="mt-px shrink-0" />
      : <ArrowBigUp size={13} aria-hidden className="mt-px shrink-0" />}
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

// A password rule, ticked once it's met. Grey until a Create click, then red
// if still missing.
const Rule = ({ ok, strict, children }: { ok: boolean; strict: boolean; children: React.ReactNode }) => (
  <li className={`flex items-center gap-2 transition-colors ${ok ? "text-success" : strict ? "text-danger" : "text-subtle"}`}>
    <span
      aria-hidden
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
        ok ? "border-success/60 bg-success/15" : strict ? "border-danger/60" : "border-zinc-600"
      }`}
    >
      {ok && <Check size={10} strokeWidth={3} />}
    </span>
    <span className="sr-only">{ok ? "Done: " : "Needed: "}</span>
    {children}
  </li>
);

// The page's message about the last action, with a close button. Selectable,
// so an export path can be copied.
const Banner = ({ tone, children, onClose }: { tone: "error" | "info"; children: React.ReactNode; onClose: () => void }) => (
  <div
    role={tone === "error" ? "alert" : "status"}
    className={`mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-left text-[12px] leading-4 animate-in ${
      tone === "error" ? "bg-danger/[0.12] text-danger" : "bg-success/[0.12] text-success"
    }`}
  >
    {tone === "error"
      ? <AlertTriangle size={13} aria-hidden className="mt-px shrink-0" />
      : <CheckCircle2 size={13} aria-hidden className="mt-px shrink-0" />}
    <span className="min-w-0 flex-1 break-words text-white select-text">{children}</span>
    <button
      type="button"
      onClick={onClose}
      aria-label="Dismiss"
      className="-mr-1.5 -mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-white/10 hover:text-white"
    >
      <X size={12} aria-hidden />
    </button>
  </div>
);

interface MenuItem { label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean; }
// Where a menu opens: under (or, short of room, over) the span top..bottom,
// with its right edge at `x` when `end`, else its left edge.
interface MenuPlace { x: number; top: number; bottom: number; end: boolean; }

// A row's actions in a small menu. Arrow keys move, Enter picks, Escape or
// Tab close it, and a click outside closes it without doing anything else.
const RowMenu = ({ label, items, place, onClose }: {
  label: string; items: MenuItem[]; place: MenuPlace; onClose: (refocus: boolean) => void;
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Measured off screen first, then placed inside the window, all before the
  // first paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(place.end ? place.x - w : place.x, window.innerWidth - w - 8));
    const below = place.bottom + 4;
    const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, place.top - h - 4);
    setPos({ left, top });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    if (typeof el.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 120, easing: "ease-out" });
    }
  }, [place]);

  useEffect(() => {
    const close = () => onCloseRef.current(false);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); all[(n + all.length) % all.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose(true); }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onClick={() => onClose(false)}
        onContextMenu={(e) => { e.preventDefault(); onClose(false); }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        style={pos ?? { left: -9999, top: -9999 }}
        className="fixed z-[9999] min-w-[200px] rounded-lg bg-elevated p-1 shadow-pop"
      >
        {items.map((it, i) => (
          <Fragment key={it.label}>
            {it.danger && i > 0 && !items[i - 1].danger && <div role="separator" className="mx-1 my-1 h-px bg-white/[0.075]" />}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              // Focus goes back to ⋯ first, so a confirm that opens next
              // returns it there.
              onClick={() => { onClose(true); it.onSelect(); }}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors ${
                it.danger ? "text-danger hover:bg-danger/10 focus:bg-danger/10" : "text-white hover:bg-white/[0.06] focus:bg-white/[0.06]"
              }`}
            >
              <span className="shrink-0 text-muted">{it.icon}</span>
              {it.label}
            </button>
          </Fragment>
        ))}
      </div>
    </>,
    document.body,
  );
};

// A low-key text button for the footer row.
const FooterButton = ({
  onClick, disabled, title, icon, label, tone,
}: {
  onClick: () => void; disabled?: boolean; title: string; icon: React.ReactNode; label: string; tone?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`h-7 px-2 rounded-md flex items-center gap-1.5 transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-transparent ${
      tone || "text-subtle hover:text-white"
    }`}
  >
    {icon} {label}
  </button>
);

const FooterDot = () => <span aria-hidden className="text-subtle select-none">·</span>;

const CloudBar = ({
  status, host, busy, firstRun, onManage,
}: {
  status: CloudStatus;
  host: string | null;
  busy: boolean;
  firstRun: boolean;
  onManage: () => void;
}) => {
  // Signed out: a light link rather than another full-width button. The
  // user hasn't asked for cloud yet, so it shouldn't compete with the
  // profiles. On a first run it's how a returning user finds theirs.
  if (!status.signed_in) {
    return (
      <div className="mt-4 flex flex-col items-center gap-0.5">
        {firstRun && <span className="text-[12px] text-subtle">Already have profiles in the cloud?</span>}
        <button type="button" onClick={onManage} className="btn btn-ghost h-8 text-[12px] hover:text-primary">
          <Cloud size={14} aria-hidden /> Connect cloud sync
        </button>
      </div>
    );
  }
  return (
    <div className="tile mt-3 flex items-center gap-3 py-2 pl-2.5 pr-1.5 text-left">
      <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/[0.12] text-primary">
        <Cloud size={15} aria-hidden />
        <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-panel" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-white">{status.email}</span>
        <span className="block truncate text-[11px] text-subtle">{host ? `Signed in to ${host}` : "Signed in"}</span>
      </span>
      <button type="button" onClick={onManage} disabled={busy} title="Manage cloud account" className="btn btn-sm">
        Manage
      </button>
    </div>
  );
};

export default ProfileSelectPage;
