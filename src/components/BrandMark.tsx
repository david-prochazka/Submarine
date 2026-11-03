import { useId } from "react";

const RIVETS: [number, number][] = [[23.1, 23.1], [76.9, 23.1], [23.1, 76.9], [76.9, 76.9]];

/** The Supermarine porthole mark. Rivets and the wave line are cut out with a
 *  mask, so it sits on any surface; the colours follow the theme. */
export default function BrandMark({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--brand-prompt-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-prompt-to)" }} />
        </linearGradient>
        <linearGradient id={`${id}w`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--brand-wave-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-wave-to)" }} />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <circle cx="50" cy="50" r="31" />
        </clipPath>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          {RIVETS.map(([cx, cy]) => <circle key={cx * 100 + cy} cx={cx} cy={cy} r="2.4" fill="#000" />)}
          <path d="M10 74 C26 66 40 66 52 71 S76 78 92 69" stroke="#666" strokeWidth="3" fill="none" clipPath={`url(#${id}c)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}m)`}>
        <circle cx="50" cy="50" r="38" stroke="rgb(var(--ink))" strokeWidth="8" fill="none" />
        <path d="M10 62 C26 53 40 53 52 59 S76 67 92 57 V96 H10 Z" fill={`url(#${id}w)`} clipPath={`url(#${id}c)`} />
      </g>
      <path d="M34 30 L44 38 L34 46" stroke={`url(#${id}p)`} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
