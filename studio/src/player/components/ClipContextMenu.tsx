import { memo } from "react";
import { useClipboardActions } from "../../contexts/ClipboardActionsContext";
import { createPortal } from "react-dom";
import type { TimelineElement } from "../store/playerStore";
import { canSplitElement } from "../../utils/timelineElementSplit";
import { useContextMenuDismiss } from "../../hooks/useContextMenuDismiss";
import { useMenuKeyboardNav } from "./menuKeyboardNav";
import { usePlayerStore } from "../store/playerStore";

interface ClipContextMenuProps {
  x: number;
  y: number;
  element: TimelineElement;
  currentTime: number;
  onClose: () => void;
  onSplit: (element: TimelineElement, splitTime: number) => void;
  onDelete: (element: TimelineElement) => void;
  onToggleMuted: (element: TimelineElement, muted: boolean) => void;
}

export const ClipContextMenu = memo(function ClipContextMenu({
  x,
  y,
  element,
  currentTime,
  onClose,
  onSplit,
  onDelete,
  onToggleMuted,
}: ClipContextMenuProps) {
  const clipboard = useClipboardActions();
  const thumbnailMode = usePlayerStore((state) => state.thumbnailMode);
  const setThumbnailMode = usePlayerStore((state) => state.setThumbnailMode);
  const menuRef = useContextMenuDismiss(onClose);
  useMenuKeyboardNav(menuRef);

  const menuWidth = 200;
  const showsVisualThumbnails =
    element.tag === "video" || element.tag === "img" || Boolean(element.compositionSrc);
  const canMute =
    !element.compositionSrc &&
    element.kind !== "composition" &&
    (element.tag === "video" || element.tag === "audio");
  const isMuted = element.muted === true;
  const menuHeight = (showsVisualThumbnails ? 116 : 80) + (canMute ? 36 : 0) + (clipboard ? 160 : 0);
  const overflowY = y + menuHeight - window.innerHeight;
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const adjustedY = overflowY > 0 ? y - overflowY - 8 : y;

  const isSplittable = canSplitElement(element);
  const canSplit =
    isSplittable && currentTime > element.start && currentTime < element.start + element.duration;

  const splitLabel = isSplittable ? "Split" : null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Clip actions"
      className="fixed z-[200] bg-neutral-900 border border-neutral-700 rounded-md py-1 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {clipboard && (
        <>
          {(
            [
              ["Copy", "⌘/Ctrl C", clipboard.copy],
              ["Cut", "⌘/Ctrl X", clipboard.cut],
              ["Paste", "⌘/Ctrl V", clipboard.paste],
              ["Duplicate", "⌘/Ctrl D", clipboard.duplicate],
              ["Select all clips", "⌘/Ctrl A", clipboard.selectAll],
            ] as const
          ).map(([label, shortcut, action]) => (
            <button
              type="button"
              role="menuitem"
              key={label}
              className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-left text-neutral-300 outline-none hover:bg-neutral-800 focus-visible:bg-neutral-800"
              onClick={() => {
                usePlayerStore.getState().clearSelectedKeyframes();
                void action();
                onClose();
              }}
            >
              <span>{label}</span>
              <span className="text-neutral-500 text-[10px] ml-3">{shortcut}</span>
            </button>
          ))}
          <div className="my-1 border-t border-neutral-700/60" />
        </>
      )}
      {splitLabel && (
        <>
          <button
            type="button"
            role="menuitem"
            className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left outline-none focus-visible:bg-neutral-800 ${
              canSplit
                ? "text-neutral-300 hover:bg-neutral-800 cursor-pointer"
                : "text-neutral-600 cursor-not-allowed"
            }`}
            disabled={!canSplit}
            onClick={() => {
              if (canSplit) {
                onSplit(element, currentTime);
                onClose();
              }
            }}
          >
            <span>{splitLabel}</span>
            <span className="text-neutral-500 text-[10px] ml-3">S</span>
          </button>
          <div className="my-1 border-t border-neutral-700/60" />
        </>
      )}

      {showsVisualThumbnails && (
        <>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={thumbnailMode === "adaptive"}
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-left text-neutral-300 outline-none hover:bg-neutral-800 focus-visible:bg-neutral-800 cursor-pointer"
            onClick={() => {
              setThumbnailMode(thumbnailMode === "adaptive" ? "hidden" : "adaptive");
              onClose();
            }}
          >
            <span>Show thumbnails</span>
            <span className="w-4 text-right text-studio-accent" aria-hidden="true">
              {thumbnailMode === "adaptive" ? "✓" : ""}
            </span>
          </button>
          <div className="my-1 border-t border-neutral-700/60" />
        </>
      )}

      {canMute && (
        <>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isMuted}
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-left text-neutral-300 outline-none hover:bg-neutral-800 focus-visible:bg-neutral-800 cursor-pointer"
            onClick={() => {
              onToggleMuted(element, !isMuted);
              onClose();
            }}
          >
            <span>{isMuted ? "Unmute" : "Mute"}</span>
            <span className="w-4 text-right text-studio-accent" aria-hidden="true">
              {isMuted ? "✓" : ""}
            </span>
          </button>
          <div className="my-1 border-t border-neutral-700/60" />
        </>
      )}

      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-red-400 hover:bg-neutral-800 focus-visible:bg-neutral-800 outline-none cursor-pointer text-left"
        onClick={() => {
          onDelete(element);
          onClose();
        }}
      >
        <span>Delete</span>
        <span className="text-neutral-500 text-[10px] ml-3">⌫</span>
      </button>
    </div>,
    document.body,
  );
});
