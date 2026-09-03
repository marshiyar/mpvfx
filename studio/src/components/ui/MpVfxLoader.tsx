export interface MpVfxLoaderProps {
  /** Status text shown below the mark. */
  title: string;
  /** Optional secondary detail line. */
  detail?: string;
  /** Optional monospace third line for IDs, counts, or percentages. */
  mono?: string;
  /** Pixel size of the mark itself; status text scales independently. */
  size?: number;
  /** Optional normalized progress value from 0 to 1. */
  progress?: number;
}

export function MpVfxLoader({
  title,
  detail,
  mono,
  size = 64,
  progress,
}: MpVfxLoaderProps) {
  const boundedProgress =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.min(1, Math.max(0, progress))
      : undefined;
  const markFrameSize = Math.round(size * 1.16);

  return (
    <div className="hf-loader" role="status" draggable={false}>
      <div
        className="hf-loader-mark-frame"
        style={{ width: markFrameSize, height: markFrameSize }}
        draggable={false}
      >
        <svg
          className="hf-loader-mark"
          width={size}
          height={size}
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r="29" stroke="currentColor" strokeWidth="7" opacity=".2" />
          <path
            d="M50 21A29 29 0 0 1 79 50"
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="hf-loader-title">{title}</div>
      {detail && <div className="hf-loader-detail">{detail}</div>}
      {boundedProgress !== undefined && (
        <div
          className="hf-loader-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(boundedProgress * 100)}
        >
          <div
            className="hf-loader-progress__fill"
            style={{ transform: `scaleX(${boundedProgress})` }}
          />
        </div>
      )}
      {mono && <div className="hf-loader-mono">{mono}</div>}
    </div>
  );
}

// fallow-ignore-next-line unused-export
export function StatusFrame(props: MpVfxLoaderProps) {
  return (
    <div className="hf-frame">
      <MpVfxLoader {...props} />
    </div>
  );
}
