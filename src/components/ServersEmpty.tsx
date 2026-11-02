import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Zap, Server, TerminalSquare, FileUp, FileJson, Check } from "lucide-react";
import { IS_ANDROID } from "../util/platform";

export type ImportRequest = { source: "ssh" } | { source: "paste"; text: string };

type FileSource = { id: string; name: string; detail: string; accept: string; icon: typeof FileUp };

const FILE_SOURCES: FileSource[] = [
  { id: "putty", name: "PuTTY", detail: ".reg export", accept: ".reg,text/plain", icon: TerminalSquare },
  { id: "moba", name: "MobaXterm", detail: ".mxtsessions", accept: ".mxtsessions,.ini,text/plain", icon: TerminalSquare },
  { id: "json", name: "JSON", detail: ".json host list", accept: ".json,application/json", icon: FileJson },
];

const sourceCard =
  "tile tile-hover flex flex-col gap-3 p-4 text-left disabled:opacity-60";
const sourceIcon =
  "w-[34px] h-[34px] rounded-[9px] flex items-center justify-center bg-white/[0.06] text-zinc-400";

export const ServersEmpty = ({ onNewServer, onQuickConnect, onImport }: {
  onNewServer: () => void;
  onQuickConnect?: () => void;
  onImport: (req: ImportRequest) => void;
}) => {
  // How many hosts ~/.ssh/config has, so the card can say whether it's worth
  // a click. null while reading; -1 when there's no config to read.
  const [sshHosts, setSshHosts] = useState<number | null>(IS_ANDROID ? -1 : null);
  useEffect(() => {
    if (IS_ANDROID) return;
    let live = true;
    invoke<unknown[]>("parse_ssh_config", { path: null })
      .then((hosts) => { if (live) setSshHosts(hosts.length); })
      .catch(() => { if (live) setSshHosts(-1); });
    return () => { live = false; };
  }, []);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const pickFile = (src: FileSource) => {
    const input = fileInput.current;
    if (!input) return;
    setFileError(null);
    input.accept = src.accept;
    input.value = "";
    input.click();
  };
  const readPicked = async (file: File | undefined) => {
    if (!file) return;
    try {
      onImport({ source: "paste", text: await file.text() });
    } catch {
      setFileError(`Couldn't read ${file.name}.`);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar flex items-center justify-center p-6 sm:p-8">
      <div className="w-full max-w-[640px] text-center">
        <div aria-hidden className="relative w-[132px] h-[132px] mx-auto mb-[22px]">
          {[0, 1.06, 2.13].map((delay) => (
            <span
              key={delay}
              className="absolute inset-0 rounded-full border border-primary animate-sonar motion-reduce:animate-none motion-reduce:opacity-20"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
          <span className="absolute inset-[34px] rounded-full bg-primary/[0.12] ring-1 ring-inset ring-primary flex items-center justify-center text-primary">
            <Server size={26} />
          </span>
        </div>

        <h1 className="text-[22px] leading-7 font-semibold text-white">Add your first server</h1>
        <p className="mt-2 mx-auto max-w-[440px] text-zinc-400 leading-5">
          Connect over SSH, SFTP, RDP, VNC or Telnet. Passwords and keys are stored in your encrypted vault, never in plain text.
        </p>
        <div className="mt-5 flex flex-wrap gap-2 justify-center">
          <button type="button" onClick={onNewServer} className="btn btn-primary h-8 px-3.5">
            <Plus size={14} aria-hidden /> New server
          </button>
          {onQuickConnect && (
            <button type="button" onClick={onQuickConnect} className="btn h-8 px-3.5">
              <Zap size={14} aria-hidden /> Quick connect
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 mt-10 mb-3.5 text-[12px] text-zinc-500">
          <span aria-hidden className="flex-1 h-px bg-white/[0.14]" />
          Or import from another app
          <span aria-hidden className="flex-1 h-px bg-white/[0.14]" />
        </div>

        <ul className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <li className="contents">
            <button
              type="button"
              onClick={() => onImport({ source: "ssh" })}
              disabled={sshHosts === -1 || sshHosts === 0}
              className={`${sourceCard} ${sshHosts && sshHosts > 0 ? "shadow-[0_0_0_1px_rgb(var(--primary))]" : ""}`}
            >
              <span className={sourceIcon}><TerminalSquare size={17} aria-hidden /></span>
              <span>
                <span className="block font-semibold text-white">SSH config</span>
                <span className="block mt-0.5 font-mono text-[11.5px] text-zinc-400">~/.ssh/config</span>
              </span>
              <span className={`flex items-center gap-1.5 text-[12px] font-medium ${sshHosts && sshHosts > 0 ? "text-primary" : "text-zinc-400"}`}>
                {sshHosts === null ? "Looking…"
                  : sshHosts === -1 ? "Not found"
                  : sshHosts === 0 ? "No hosts in it"
                  : <><Check size={13} aria-hidden /> Found {sshHosts} {sshHosts === 1 ? "host" : "hosts"}</>}
              </span>
            </button>
          </li>
          {FILE_SOURCES.map((src) => (
            <li key={src.id} className="contents">
              <button type="button" onClick={() => pickFile(src)} className={sourceCard}>
                <span className={sourceIcon}><src.icon size={17} aria-hidden /></span>
                <span>
                  <span className="block font-semibold text-white">{src.name}</span>
                  <span className="block mt-0.5 font-mono text-[11.5px] text-zinc-400">{src.detail}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-400">
                  <FileUp size={13} aria-hidden /> Choose file
                </span>
              </button>
            </li>
          ))}
        </ul>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(e) => readPicked(e.target.files?.[0])}
        />
        {fileError && <p role="alert" className="mt-3 text-[12px] text-danger">{fileError}</p>}
        <p className="mt-4 text-[12px] text-zinc-500">
          You pick which hosts to add. Key files they name can be copied into the vault as they import.
        </p>
      </div>
    </div>
  );
};
