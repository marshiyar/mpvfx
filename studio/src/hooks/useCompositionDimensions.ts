import { useRef, useState } from "react";
import { useMountEffect } from "./useMountEffect";
import type { CompositionDimensions } from "../components/renders/RenderQueue";
import { acceptStudioRuntimeMessage } from "../player/lib/runtimeProtocol";

function readCompositionSizeMessage(data: unknown): CompositionDimensions | null {
  if (!isStageSizeMessage(data)) return null;
  const message = data;
  if (!acceptStudioRuntimeMessage(message)) return null;
  return readPositiveDimensions(message.width, message.height);
}

function isStageSizeMessage(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  const message = value as Record<string, unknown>;
  return message.source === "hf-preview" && message.type === "stage-size";
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPositiveDimensions(width: unknown, height: unknown): CompositionDimensions | null {
  const parsedWidth = readPositiveNumber(width);
  const parsedHeight = readPositiveNumber(height);
  if (parsedWidth === null || parsedHeight === null) return null;
  return { width: parsedWidth, height: parsedHeight };
}

export function useCompositionDimensions(
  ownerKey?: unknown,
  sourceFrameRef?: { readonly current: HTMLIFrameElement | null },
) {
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [ownedDimensions, setOwnedDimensions] = useState<{
    ownerKey: unknown;
    dimensions: CompositionDimensions | null;
  }>({ ownerKey, dimensions: null });

  useMountEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (sourceFrameRef) {
        const expectedSource = sourceFrameRef.current?.contentWindow;
        if (!expectedSource || e.source !== expectedSource) return;
      }
      const dimensions = readCompositionSizeMessage(e.data);
      if (!dimensions) return;
      const currentOwnerKey = ownerKeyRef.current;
      setOwnedDimensions((prev) =>
        Object.is(prev.ownerKey, currentOwnerKey) &&
        prev.dimensions?.width === dimensions.width &&
        prev.dimensions.height === dimensions.height
          ? prev
          : { ownerKey: currentOwnerKey, dimensions },
      );
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  });

  // Return null during the very render that changes ownership. An effect-based
  // reset leaves one render where the previous scene's aspect can be persisted.
  return Object.is(ownedDimensions.ownerKey, ownerKey) ? ownedDimensions.dimensions : null;
}
