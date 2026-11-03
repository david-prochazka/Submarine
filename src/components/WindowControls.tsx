import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_ANDROID, IS_MAC, IS_TAURI } from "../util/platform";

// Every desktop window has traffic lights at its top-left corner. On macOS
// they are the system's own (tauri.macos.conf.json overlays the title bar);
// elsewhere, and in a browser preview, this draws them in the same place.
export const HAS_LIGHTS = !IS_ANDROID;
const NATIVE_LIGHTS = IS_MAC && IS_TAURI;

// Left padding for a bar that runs under the lights.
export const LIGHTS_INSET = "pl-[80px]";

const appWindow = IS_TAURI ? getCurrentWindow() : null;

const LIGHTS = [
  { label: "Close", tone: "bg-[#ff5f57] border-[#e2463f]", idle: "group-hover:bg-[#ff5f57] group-hover:border-[#e2463f]", act: () => appWindow?.close(), glyph: <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /> },
  { label: "Minimize", tone: "bg-[#febc2e] border-[#e1a116]", idle: "group-hover:bg-[#febc2e] group-hover:border-[#e1a116]", act: () => appWindow?.minimize(), glyph: <path d="M2 5h6" /> },
  { label: "Zoom", tone: "bg-[#28c840] border-[#1aab29]", idle: "group-hover:bg-[#28c840] group-hover:border-[#1aab29]", act: () => appWindow?.toggleMaximize(), glyph: <path d="M5 2v6M2 5h6" /> },
];

export function TrafficLights() {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!appWindow || NATIVE_LIGHTS || !HAS_LIGHTS) return;
    let unlisten: (() => void) | undefined;
    appWindow.onFocusChanged(({ payload }) => setFocused(payload)).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => unlisten?.();
  }, []);

  if (NATIVE_LIGHTS || !HAS_LIGHTS) return null;
  return (
    <div className="group fixed left-4 top-4 z-[90] flex gap-2 no-drag" role="group" aria-label="Window">
      {LIGHTS.map((l) => (
        <button
          key={l.label}
          type="button"
          tabIndex={-1}
          aria-label={l.label}
          onClick={() => l.act()?.catch(console.error)}
          className={`w-3 h-3 rounded-full border-[0.5px] flex items-center justify-center ${
            focused ? l.tone : `bg-white/15 border-white/10 ${l.idle}`
          }`}
        >
          <svg viewBox="0 0 10 10" aria-hidden className="w-2 h-2 stroke-black/60 stroke-[1.3] opacity-0 group-hover:opacity-100" fill="none" strokeLinecap="round">
            {l.glyph}
          </svg>
        </button>
      ))}
    </div>
  );
}
