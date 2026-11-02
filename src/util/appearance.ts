import { useEffect } from "react";

// Light, dark, or whatever the OS is set to. Per-device, like the other
// preferences. The palette itself lives in App.css (`:root[data-theme]`).
export type Appearance = "system" | "dark" | "light";

export const APPEARANCE_KEY = "submarine-appearance";
const ACCENT_KEY = "submarine-primary-color";

// The accent every install had before the redesign. Someone who never picked
// one still has it stored; they get the theme's own accent instead.
const LEGACY_DEFAULT_ACCENT = "#60a5fa";

export function readAppearance(): Appearance {
  const v = localStorage.getItem(APPEARANCE_KEY);
  return v === "dark" || v === "light" ? v : "system";
}

/** '' = the theme's own accent, which differs between light and dark. */
export function readAccent(): string {
  const v = localStorage.getItem(ACCENT_KEY) || "";
  return v.toLowerCase() === LEGACY_DEFAULT_ACCENT ? "" : v;
}

const hexToChannels = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** Puts the chosen theme and accent on <html> and keeps them stored. */
export function useAppearance(appearance: Appearance, accent: string) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = appearance === "light" || (appearance === "system" && media.matches);
      document.documentElement.dataset.theme = light ? "light" : "dark";
    };
    apply();
    localStorage.setItem(APPEARANCE_KEY, appearance);
    if (appearance !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement.style;
    if (/^#[0-9a-f]{6}$/i.test(accent)) {
      root.setProperty("--primary", hexToChannels(accent));
      root.setProperty("--primary-hex", accent);
      localStorage.setItem(ACCENT_KEY, accent);
    } else {
      root.removeProperty("--primary");
      root.removeProperty("--primary-hex");
      localStorage.removeItem(ACCENT_KEY);
    }
  }, [accent]);
}
