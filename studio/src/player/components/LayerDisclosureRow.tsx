import { TRACK_H } from "./timelineLayout";
import { TrackClipCount } from "./TrackClipCount";

export function LayerDisclosureRow({
  name,
  clipCount,
  gutterBackground,
  columnWidth,
  isExpanded,
  lanesId,
  onToggle,
  children,
}: {
  /** What this row is called. The active clip's own name when it is alone on the
   *  track; the track itself once it holds several, since naming a shared row
   *  after one of its clips reads as if the rows under it were that clip's. */
  name: string;
  clipCount: number;
  gutterBackground: string;
  /** Same adaptive width the lane rows use: a narrowed header column must not
   *  leave this row hanging over the clips it labels. */
  columnWidth: number;
  isExpanded: boolean;
  lanesId: string;
  onToggle: () => void;
  /** Trailing controls that act on the LAYER (the visibility eye), not on a lane. */
  children?: React.ReactNode;
}) {
  return (
    <div
      className="absolute left-0 top-0 flex items-center gap-1.5 overflow-hidden px-1.5 text-[11px]"
      style={{
        width: columnWidth,
        height: TRACK_H,
        color: "#ffffff",
        background: gutterBackground,
      }}
    >
      <button
        type="button"
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${name} lanes`}
        aria-expanded={isExpanded}
        aria-controls={lanesId}
        className="shrink-0 border-0 bg-transparent p-0 text-[13px] leading-none text-white/70"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {isExpanded ? "▾" : "›"}
      </button>
      {/* Wraps rather than truncating: a truncated name needs a hover to be
          read, which a scanned column cannot rely on. */}
      <span className="min-w-0 flex-1 break-words font-medium leading-tight">{name}</span>
      <TrackClipCount clipCount={clipCount} />
      {children}
    </div>
  );
}
