import defaultColors from "tailwindcss/colors";
import plugin from "tailwindcss/plugin";

// Every neutral and status hue resolves through a CSS variable, so one class
// (`text-zinc-400`, `bg-white/5`, `text-amber-300`) reads right in both themes.
// Dark keeps Tailwind's shades; light mirrors them (300 ↔ 700, 100 ↔ 900…) so
// a pale text colour on a dark panel becomes a deep one on a white panel.
const HUES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
  "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const mirror = (shade) => SHADES[SHADES.length - 1 - SHADES.indexOf(shade)];

// Cool neutrals from the design tokens: 400 = muted, 500 = subtle, 900 = panel.
const ZINC_DARK = {
  50: "#F4F5F7", 100: "#E8EAED", 200: "#D5D9DE", 300: "#BCC2C9", 400: "#A3A9B1", 500: "#9198A1",
  600: "#6A717A", 700: "#3A3F46", 800: "#2B2F35", 900: "#1D2024", 950: "#131518",
};
const ZINC_LIGHT = {
  50: "#0E1013", 100: "#1A1D21", 200: "#2A2E33", 300: "#3A3F46", 400: "#555C65", 500: "#626973",
  600: "#8B929B", 700: "#B9BEC5", 800: "#DDE0E4", 900: "#EEF0F2", 950: "#F7F8F9",
};

const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

const scale = (hue) => Object.fromEntries(SHADES.map((s) => [s, v(`c-${hue}-${s}`)]));

const paletteVars = (light) => {
  const out = {};
  for (const s of SHADES) out[`--c-zinc-${s}`] = channels((light ? ZINC_LIGHT : ZINC_DARK)[s]);
  for (const hue of HUES) {
    for (const s of SHADES) out[`--c-${hue}-${s}`] = channels(defaultColors[hue][light ? mirror(s) : s]);
  }
  return out;
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // `white` is the ink colour and `black` its opposite: text-white is the
        // foreground, bg-white/5 a hover tint, text-black the text on a primary
        // button. `snow` stays white in both themes (switch knobs, text on red).
        white: v("ink"),
        black: v("ink-inverse"),
        snow: "#ffffff",
        zinc: scale("zinc"),
        neutral: scale("zinc"),
        gray: scale("zinc"),
        slate: scale("zinc"),
        ...Object.fromEntries(HUES.map((h) => [h, scale(h)])),
        background: v("background"),
        sidebar: v("sidebar"),
        surface: v("surface"),
        panel: v("panel"),
        elevated: v("elevated"),
        control: v("control"),
        field: v("field"),
        terminal: v("terminal"),
        scrim: "var(--scrim)",
        foreground: v("ink"),
        muted: v("muted"),
        subtle: v("subtle"),
        primary: v("primary"),
        success: v("success"),
        warning: v("warning"),
        danger: v("danger"),
        info: v("info"),
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', "Inter", "system-ui", "sans-serif"],
        mono: ['"SF Mono"', '"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
      boxShadow: {
        pop: "var(--shadow-pop)",
        sheet: "var(--shadow-sheet)",
        control: "var(--shadow-control)",
      },
      keyframes: {
        sonar: {
          "0%": { transform: "scale(.6)", opacity: ".55" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
      },
      animation: {
        sonar: "sonar 3.2s ease-out infinite",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(.2,.8,.2,1)",
        out: "cubic-bezier(.2,.8,.2,1)",
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root": paletteVars(false),
        ':root[data-theme="light"]': paletteVars(true),
      });
    }),
  ],
};
