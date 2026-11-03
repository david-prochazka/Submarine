import { useState } from "react";
import { Zap, X, AlertTriangle, KeyRound, Lock } from "lucide-react";
import PasswordField from "./PasswordField";

// Quick Connect: the auth bundle lives in component state, gets passed to
// DesktopApp via onConnect, and the resulting session carries it through to
// `initiate_connection`'s `quick_auth` param on the backend (so the live
// connection uses the inline auth directly). DesktopApp ALSO persists the
// target as a reusable node in the root directory (see save_quick_connect_node)
// so it can be reconnected later without re-typing credentials.

export interface QuickAuth {
  host: string;
  port: number;
  username: string;
  password?: string | null;
  private_key?: string | null;
  passphrase?: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (auth: QuickAuth) => void;
}

const QuickConnectModal = ({ isOpen, onClose, onConnect }: Props) => {
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState("root");
  const [authMode, setAuthMode] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setHost(""); setPort(22); setUsername("root");
    setAuthMode("password"); setPassword(""); setPrivateKey(""); setPassphrase("");
    setErr(null);
  };

  const close = () => { reset(); onClose(); };

  const connect = () => {
    setErr(null);
    if (!host.trim()) { setErr("Host is required"); return; }
    if (!port || port < 1 || port > 65535) { setErr("Port must be 1–65535"); return; }
    if (authMode === "key" && !privateKey.trim()) { setErr("Private key body is required"); return; }

    // A blank username (issue #54) and an empty password (issue #30) are both
    // asked for when connecting; an empty "Login as" answer means root.
    const auth: QuickAuth = {
      host: host.trim(),
      port,
      username: username.trim(),
      password: authMode === "password" && password ? password : null,
      private_key: authMode === "key" ? privateKey : null,
      passphrase: authMode === "key" && passphrase ? passphrase : null,
    };
    reset();
    onConnect(auth);
  };

  return (
    <div className="fixed inset-0 z-50 bg-scrim flex items-center justify-center p-3" onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="quick-connect-title" className="w-full max-w-md max-h-[90vh] flex flex-col bg-elevated rounded-xl shadow-sheet text-[13px] animate-in zoom-in-95 fade-in duration-150" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="shrink-0 px-4 pt-4 pb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="quick-connect-title" className="text-[15px] font-semibold text-white">Quick connect</h2>
            <p className="mt-0.5 text-[12px] text-zinc-400">Saved as a server in All servers, so you can open it again.</p>
          </div>
          <button type="button" aria-label="Close" onClick={close} className="icon-btn -mr-1 -mt-0.5"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pt-2 pb-4 space-y-3">
          {err && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">
              <AlertTriangle size={14} aria-hidden className="text-danger shrink-0 mt-px" /> {err}
            </div>
          )}

          {/* Host + port */}
          <div className="grid grid-cols-4 gap-2">
            <div className="col-span-3 space-y-1">
              <label htmlFor="qc-host" className="text-[12px] text-zinc-400">Host</label>
              <input
                id="qc-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.1 or example.com"
                className="field h-8"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="qc-port" className="text-[12px] text-zinc-400">Port</label>
              <input
                id="qc-port"
                type="number"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value) || 22)}
                className="field h-8"
              />
            </div>
          </div>

          {/* Username */}
          <div className="space-y-1">
            <label htmlFor="qc-user" className="text-[12px] text-zinc-400">Username</label>
            <input
              id="qc-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Ask when connecting"
              className="field h-8"
            />
          </div>

          {/* Auth mode toggle */}
          <div className="pt-1">
            <div role="group" aria-label="Sign in with" className="seg w-full">
              <button
                type="button"
                onClick={() => setAuthMode("password")}
                aria-pressed={authMode === "password"}
                className="seg-item flex-1"
              >
                <Lock size={12} aria-hidden /> Password
              </button>
              <button
                type="button"
                onClick={() => setAuthMode("key")}
                aria-pressed={authMode === "key"}
                className="seg-item flex-1"
              >
                <KeyRound size={12} aria-hidden /> SSH key
              </button>
            </div>
          </div>

          {authMode === "password" ? (
            <div className="space-y-1 animate-in fade-in">
              <label className="text-[12px] text-zinc-400">Password</label>
              <PasswordField
                value={password}
                onChange={setPassword}
                placeholder="••••••"
                aria-label="Password"
                onKeyDown={(e: any) => e.key === "Enter" && connect()}
                className="field h-8"
              />
              <p className="text-[11.5px] leading-[15px] text-zinc-500">Leave empty to be asked when connecting.</p>
            </div>
          ) : (
            <div className="space-y-2 animate-in fade-in">
              <div className="space-y-1">
                <label htmlFor="qc-key" className="text-[12px] text-zinc-400">Private key (PEM)</label>
                <textarea
                  id="qc-key"
                  spellCheck={false}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  className="field h-auto py-2 font-mono text-[12px] resize-y"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] text-zinc-400">Passphrase</label>
                <PasswordField
                  value={passphrase}
                  onChange={setPassphrase}
                  placeholder="None"
                  aria-label="Passphrase"
                  className="field h-8"
                />
                <p className="text-[11.5px] leading-[15px] text-zinc-500">For an encrypted key, leave empty to be asked when connecting.</p>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-3 border-t border-white/[0.075] flex items-center justify-end gap-2">
          <button type="button" onClick={close} className="btn">
            Cancel
          </button>
          <button type="button" onClick={connect} className="btn btn-primary">
            <Zap size={14} aria-hidden /> Connect
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuickConnectModal;
