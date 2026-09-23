import { useState, useEffect } from "react";
import { decodeVideoThumbnail } from "../player/lib/thumbnailVideoDecoder";

/** The native decoder supplies a poster; this component only displays it. */
export function VideoFrameThumbnail({
  src,
  fallbackLabel,
  onDuration,
}: {
  src: string;
  /** Shown instead of an endless shimmer when the video can't be decoded. */
  fallbackLabel?: string;
  onDuration?: (duration: number) => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFrame(null);
    setFailed(false);
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    void decodeVideoThumbnail({ source: src, frameCount: 1 }, abort.signal).then(result => {
      if (abort.signal.aborted) { result.dispose?.(); return; }
      dispose = result.dispose;
      if (result.value.kind === "image") setFrame(result.value.url);
      else setFailed(true);
      if (result.duration && Number.isFinite(result.duration)) onDuration?.(result.duration);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); dispose?.(); };
  }, [src, onDuration]);

  if (failed && !frame) {
    return (
      <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
        <span className="text-[9px] font-medium text-neutral-600">{fallbackLabel ?? "VIDEO"}</span>
      </div>
    );
  }

  if (!frame) {
    return (
      <div className="w-full h-full bg-neutral-800 animate-pulse motion-reduce:animate-none" />
    );
  }

  return <img src={frame} alt="" draggable={false} className="w-full h-full object-contain" />;
}
