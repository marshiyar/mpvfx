import { useEffect, type MutableRefObject } from "react";
import type { TimelineElement } from "../store/playerStore";
import { usePlayerStore } from "../store/playerStore";
import type { TimelineTheme } from "./timelineTheme";
import type { TimelineEditCallbacks } from "./timelineCallbacks";
import {
  KeyframeDiamondContextMenu,
  type KeyframeDiamondContextMenuState,
} from "./KeyframeDiamondContextMenu";
import { ClipContextMenu } from "./ClipContextMenu";
import { TrackGapContextMenu } from "./TrackGapContextMenu";
import { copyTextToClipboard } from "../../utils/clipboard";
import { trackStudioSegmentEaseEdit } from "../../telemetry/events";
import { isRenderedKeyframeIdentityMatch } from "../../hooks/gsapShared";
import { getTimelineElementIdentity } from "../lib/timelineElementHelpers";

export interface ClipContextMenuState {
  x: number;
  y: number;
  element: TimelineElement;
  sessionEpoch: number;
}

/** Resolved model for the empty-lane-space (track gap) context menu. */
interface TrackGapContextMenuState {
  x: number;
  y: number;
  gapWidth: number | null;
  canCloseGap: boolean;
  canCloseAllGaps: boolean;
  hasAnyGaps: boolean;
}

interface TimelineOverlaysProps {
  elements: readonly TimelineElement[];
  elementsRef: MutableRefObject<readonly TimelineElement[]>;
  theme: TimelineTheme;
  kfContextMenu: KeyframeDiamondContextMenuState | null;
  setKfContextMenu: (value: KeyframeDiamondContextMenuState | null) => void;
  onDeleteKeyframe: TimelineEditCallbacks["onDeleteKeyframe"];
  onDeleteAllKeyframes: TimelineEditCallbacks["onDeleteAllKeyframes"];
  onMoveKeyframeToPlayhead: TimelineEditCallbacks["onMoveKeyframeToPlayhead"];
  onSetKeyframeInterpolation?: TimelineEditCallbacks["onSetKeyframeInterpolation"];
  clipContextMenu: ClipContextMenuState | null;
  setClipContextMenu: (value: ClipContextMenuState | null) => void;
  currentTime: number;
  onSplitElement: TimelineEditCallbacks["onSplitElement"];
  onSetElementAttributeQuiet?: TimelineEditCallbacks["onSetElementAttributeQuiet"];
  pinZoomBeforeEdit: () => void;
  onDeleteElement?: (element: TimelineElement) => Promise<void> | void;
  gapContextMenu: TrackGapContextMenuState | null;
  onDismissGapContextMenu: () => void;
  onCloseTrackGap: () => void;
  onCloseAllTrackGaps: () => void;
  onHoverGapAction: (action: "close-gap" | "close-all" | null) => void;
}

interface TimelineContextTargetInput {
  capturedElement: TimelineElement;
  targetSessionEpoch: number | undefined;
  sessionEpoch: number;
  selectedElementId: string | null;
  elements: readonly TimelineElement[];
}

/** The captured project session and current selection jointly own a context target. */
export function resolveTimelineContextElement({
  capturedElement,
  targetSessionEpoch,
  sessionEpoch,
  selectedElementId,
  elements,
}: TimelineContextTargetInput): TimelineElement | null {
  const identity = capturedElement.key ?? capturedElement.id;
  if (targetSessionEpoch !== sessionEpoch) return null;
  if (selectedElementId !== identity) return null;
  return elements.find((element) => (element.key ?? element.id) === identity) ?? null;
}

function readTimelineContextElement(
  capturedElement: TimelineElement,
  targetSessionEpoch: number | undefined,
  elements: readonly TimelineElement[],
): TimelineElement | null {
  const state = usePlayerStore.getState();
  return resolveTimelineContextElement({
    capturedElement,
    targetSessionEpoch,
    sessionEpoch: state.timelineSessionEpoch,
    selectedElementId: state.selectedElementId,
    elements,
  });
}

// The timeline's floating context menus, rendered above the scroll area.
export function TimelineOverlays({
  elements,
  elementsRef,
  theme,
  kfContextMenu,
  setKfContextMenu,
  onDeleteKeyframe,
  onDeleteAllKeyframes,
  onMoveKeyframeToPlayhead,
  onSetKeyframeInterpolation,
  clipContextMenu,
  setClipContextMenu,
  currentTime,
  onSplitElement,
  onSetElementAttributeQuiet,
  pinZoomBeforeEdit,
  onDeleteElement,
  gapContextMenu,
  onDismissGapContextMenu,
  onCloseTrackGap,
  onCloseAllTrackGaps,
  onHoverGapAction,
}: TimelineOverlaysProps) {
  const selectedElementId = usePlayerStore((state) => state.selectedElementId);
  const sessionEpoch = usePlayerStore((state) => state.timelineSessionEpoch);
  const kfTargetSessionEpoch = kfContextMenu?.sessionEpoch;
  const clipTargetSessionEpoch = clipContextMenu?.sessionEpoch;
  const keyframeElement = kfContextMenu
    ? resolveTimelineContextElement({
        capturedElement: kfContextMenu.element,
        targetSessionEpoch: kfTargetSessionEpoch,
        sessionEpoch,
        selectedElementId,
        elements,
      })
    : null;
  const clipElement = clipContextMenu
    ? resolveTimelineContextElement({
        capturedElement: clipContextMenu.element,
        targetSessionEpoch: clipTargetSessionEpoch,
        sessionEpoch,
        selectedElementId,
        elements,
      })
    : null;
  const readCurrentElement = (element: TimelineElement, targetSessionEpoch: number | undefined) =>
    readTimelineContextElement(element, targetSessionEpoch, elementsRef.current);

  useEffect(() => {
    if (kfContextMenu && !keyframeElement) setKfContextMenu(null);
  }, [keyframeElement, kfContextMenu, setKfContextMenu]);

  useEffect(() => {
    if (clipContextMenu && !clipElement) setClipContextMenu(null);
  }, [clipContextMenu, clipElement, setClipContextMenu]);

  return (
    <>
      {kfContextMenu && keyframeElement && (
        <KeyframeDiamondContextMenu
          state={{ ...kfContextMenu, element: keyframeElement }}
          onClose={() => setKfContextMenu(null)}
          onDelete={(...args) => {
            if (!readCurrentElement(keyframeElement, kfTargetSessionEpoch)) return;
            onDeleteKeyframe?.(...args);
          }}
          onDeleteAll={(_element, animationId, native) => {
            const element = readCurrentElement(keyframeElement, kfTargetSessionEpoch);
            if (!element) return;
            if (native) onDeleteAllKeyframes?.(element, animationId, native);
            else onDeleteAllKeyframes?.(element, animationId);
          }}
          onMoveToPlayhead={
            onMoveKeyframeToPlayhead
              ? (_element, ...args) => {
                  const element = readCurrentElement(keyframeElement, kfTargetSessionEpoch);
                  if (element) onMoveKeyframeToPlayhead(element, ...args);
                }
              : undefined
          }
          onSetNativeInterpolation={
            kfContextMenu.native?.hasFollowingKeyframe && onSetKeyframeInterpolation
              ? (nativeTarget, outgoing) => {
                  const nativeTargets = Array.isArray(nativeTarget)
                    ? nativeTarget
                    : undefined;
                  onSetKeyframeInterpolation(
                    getTimelineElementIdentity(keyframeElement),
                    {
                      percentage: kfContextMenu.percentage,
                      native: nativeTargets?.[0] ?? kfContextMenu.native!,
                      ...(nativeTargets ? { nativeTargets } : {}),
                    },
                    outgoing,
                  );
                }
              : undefined
          }
          // Routed to the same focused-ease-segment path a segment click takes,
          // so the menu advertises the editor that exists rather than growing a
          // second one. Offered only for a keyframe that names a tween to focus.
          onEditEase={
            kfContextMenu.animationId !== undefined && kfContextMenu.tweenPercentage !== undefined
              ? (elementId, keyframe) => {
                  if (
                    keyframe.animationId === undefined ||
                    keyframe.tweenPercentage === undefined
                  ) {
                    return;
                  }
                  usePlayerStore.getState().setFocusedEaseSegment({
                    animationId: keyframe.animationId,
                    collidingAnimationTargets: keyframe.collidingAnimationTargets,
                    tweenPercentage: keyframe.tweenPercentage,
                    elementId,
                  });
                  trackStudioSegmentEaseEdit({ action: "open" });
                }
              : undefined
          }
          onCopyProperties={(elementId, keyframe) => {
            if (keyframe.native) {
              const properties = keyframe.native.properties;
              if (!properties || Object.keys(properties).length === 0) return false;
              return copyTextToClipboard(JSON.stringify(properties, null, 2));
            }
            const entry = usePlayerStore.getState().keyframeCache.get(elementId);
            // The rendered diamond carries its authored tween identity. Do not
            // let a neighbouring row in a dense lane win by percentage; legacy
            // targets without that pair retain the canonical output-frame match.
            const kf = entry?.keyframes.find((item) =>
              isRenderedKeyframeIdentityMatch(item, keyframe, {
                start: keyframeElement.start,
                duration: keyframeElement.duration,
              }),
            );
            if (!kf) return false;
            return copyTextToClipboard(JSON.stringify(kf.properties, null, 2));
          }}
        />
      )}

      {clipContextMenu && clipElement && (
        <ClipContextMenu
          x={clipContextMenu.x}
          y={clipContextMenu.y}
          element={clipElement}
          currentTime={currentTime}
          onClose={() => setClipContextMenu(null)}
          onSplit={(_element, time) => {
            const element = readCurrentElement(clipElement, clipTargetSessionEpoch);
            if (element) onSplitElement?.(element, time);
          }}
          onDelete={() => {
            const element = readCurrentElement(clipElement, clipTargetSessionEpoch);
            if (!element) return;
            pinZoomBeforeEdit();
            onDeleteElement?.(element);
          }}
          onToggleMuted={(_element, muted) => {
            const element = readCurrentElement(clipElement, clipTargetSessionEpoch);
            if (!element) return;
            void onSetElementAttributeQuiet?.(
              element,
              "muted",
              muted ? "true" : null,
              muted ? "Mute clip" : "Unmute clip",
            );
          }}
        />
      )}

      {gapContextMenu && (
        <TrackGapContextMenu
          x={gapContextMenu.x}
          y={gapContextMenu.y}
          gapWidth={gapContextMenu.gapWidth}
          canCloseGap={gapContextMenu.canCloseGap}
          canCloseAllGaps={gapContextMenu.canCloseAllGaps}
          hasAnyGaps={gapContextMenu.hasAnyGaps}
          onClose={onDismissGapContextMenu}
          onCloseGap={onCloseTrackGap}
          onCloseAllGaps={onCloseAllTrackGaps}
          onHoverAction={onHoverGapAction}
        />
      )}
    </>
  );
}
