/** Passive child bounds shown for compound selections. These are solid,
 * square outlines so they cannot be mistaken for crop or off-canvas guides. */
export function ChildRectOutlines({
  rects,
}: {
  rects: ReadonlyArray<{
    left: number;
    top: number;
    width: number;
    height: number;
    angle?: number;
  }>;
}) {
  return (
    <>
      {rects.map((rect, index) => (
        <div
          key={index}
          className="pointer-events-none absolute border border-white/20"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            transform: rect.angle ? `rotate(${rect.angle}deg)` : undefined,
          }}
        />
      ))}
    </>
  );
}
