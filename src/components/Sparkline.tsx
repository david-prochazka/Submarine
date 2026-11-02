// A small trend line over equal time steps, drawn in the text colour. A null
// step (nothing measured then) breaks the line rather than bridging it.

const W = 132;
const H = 30;

interface SparklineProps {
  data: (number | null)[];
  min?: number;
  max?: number;
  className?: string;
  label: string;
}

const Sparkline = ({ data, min = 0, max, className = "", label }: SparklineProps) => {
  const seen = data.filter((v): v is number => v !== null);
  const lo = min;
  const hi = max ?? Math.max(lo + 1, ...seen.map((v) => v * 1.15));
  const step = data.length > 1 ? W / (data.length - 1) : W;
  const y = (v: number) => 2 + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (H - 4);

  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  data.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push([i * step, y(v)]);
    }
  });
  if (run.length) runs.push(run);

  const pts = (r: [number, number][]) => {
    const line = r.length === 1 ? [[Math.max(0, r[0][0] - step / 2), r[0][1]], [Math.min(W, r[0][0] + step / 2), r[0][1]]] : r;
    return line.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`);
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={`block w-full h-[30px] ${className}`}>
      {runs.length === 0 && (
        <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="currentColor" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />
      )}
      {runs.map((r) => {
        const p = pts(r);
        const first = p[0].split(",")[0];
        const last = p[p.length - 1].split(",")[0];
        return (
          <g key={first}>
            <polygon points={`${first},${H} ${p.join(" ")} ${last},${H}`} fill="currentColor" opacity="0.12" />
            <polyline points={p.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
};

export default Sparkline;
