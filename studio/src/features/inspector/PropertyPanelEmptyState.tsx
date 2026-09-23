import { Eye, Layers } from "../../icons/SystemIcons";
import type { DomEditSelection } from "../canvas/domEditingTypes";
import { canHideSelections } from "../timeline/timelineInspector";

function FlatEmptyState() {
  return <div className="h-full" data-property-panel-empty="true" aria-hidden="true" />;
}

function FlatMultiSelectState({
  multiSelectedElements = [],
  onGroupSelection,
  onHideAllSelected,
  onClearSelection,
}: {
  multiSelectCount: number;
  multiSelectedElements?: DomEditSelection[];
  onGroupSelection?: () => void;
  onHideAllSelected?: () => void;
  onClearSelection?: () => void;
}) {
  // One predicate for both actions and for the handler's own refusal, so the
  // button and the refusal cannot disagree about what audio is.
  const hasAudio = !canHideSelections(multiSelectedElements);
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <button type="button" data-flat-multiselect-clear="true" aria-label="Clear selection"
        title="Clear selection" onClick={onClearSelection}
        className="order-last ml-auto h-7 w-7 text-panel-text-3 hover:text-panel-text-1">
        ×
      </button>
      {/* Neither action applies to audio, so the row goes rather than showing
          an empty frame. Grouping is the LAYOUT grouper — a positioned wrapper
          around a bounding box, and an <audio> clip has none (grouping two
          produced a 0x0 div with inline left/top on elements that are never
          laid out). Hiding is visibility, which for audio doubles as mute; the
          timeline already withholds the eye on an audio track
          (`visible={!isAudioTrack}`) and this panel was the way back to the
          same write. Both handlers refuse it too — they own keyboard paths no
          hidden button can gate. */}
      {!hasAudio && (
        <div className="flex gap-2">
          <button
            type="button"
            data-flat-multiselect-group="true"
            onClick={onGroupSelection}
            className="flex h-[34px] flex-1 items-center justify-center gap-2 rounded-lg bg-panel-hover text-[11px] font-semibold text-panel-text-0"
          >
            <Layers size={13} />
            Group
          </button>
          <button
            type="button"
            data-flat-multiselect-hide-all="true"
            onClick={onHideAllSelected}
            className="flex h-[34px] items-center gap-1.5 rounded-lg border border-panel-border-input bg-panel-input px-3 text-[11px] font-medium text-panel-text-2"
          >
            <Eye size={13} />
            Hide
          </button>
        </div>
      )}
    </div>
  );
}

export function PropertyPanelEmptyState({
  multiSelectCount,
  flat,
  multiSelectedElements,
  onGroupSelection,
  onHideAllSelected,
  onClearSelection,
}: {
  multiSelectCount: number;
  flat?: boolean;
  multiSelectedElements?: DomEditSelection[];
  onGroupSelection?: () => void;
  onHideAllSelected?: () => void;
  onClearSelection?: () => void;
}) {
  if (flat) {
    return multiSelectCount > 1 ? (
      <FlatMultiSelectState
        multiSelectCount={multiSelectCount}
        multiSelectedElements={multiSelectedElements}
        onGroupSelection={onGroupSelection}
        onHideAllSelected={onHideAllSelected}
        onClearSelection={onClearSelection}
      />
    ) : (
      <FlatEmptyState />
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-900">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        {multiSelectCount > 1 ? (
          <>
            <Layers size={18} className="mb-3 text-neutral-600" />
            <p className="text-sm font-medium text-neutral-200">
              {multiSelectCount} elements selected
            </p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-neutral-500">
              Select a single element to edit its properties. Click an element in the preview or use
              its strip in the timeline.
            </p>
          </>
        ) : (
          <>
            <Eye size={18} className="mb-3 text-neutral-600" />
            <p className="text-sm font-medium text-neutral-200">
              Select an element in the preview.
            </p>
            <p className="mt-2 max-w-[260px] text-xs leading-5 text-neutral-500">
              The inspector is tuned for element edits with safer geometry controls, color picking,
              and cleaner grouped layer controls.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
