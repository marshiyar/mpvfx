import { PanelTabButton } from "./PanelTabButton";

function RightSidebarToggleButton({
  mode,
  onClick,
}: {
  mode: "hide" | "show";
  onClick: () => void;
}) {
  const label = mode === "hide" ? "Hide sidebar" : "Show sidebar";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-transparent text-neutral-500 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300"
      title={label}
      aria-label={label}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {mode === "hide" ? (
          <>
            <path d="M5 4v16" />
            <path d="m10 7 5 5-5 5" />
          </>
        ) : (
          <>
            <path d="m14 7-5 5 5 5" />
            <path d="M19 4v16" />
          </>
        )}
      </svg>
    </button>
  );
}

export function StudioRightPanelTabs({
  designActive,
  rendersActive,
  rendersLabel,
  onHide,
  onDesign,
  onRenders,
}: {
  designActive: boolean;
  rendersActive: boolean;
  rendersLabel: string;
  onHide: () => void;
  onDesign: () => void;
  onRenders: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden border-b border-neutral-800 px-3 py-2">
      <RightSidebarToggleButton mode="hide" onClick={onHide} />
      <PanelTabButton
        label="Design"
        tooltip="Element styles and properties"
        active={designActive}
        onClick={onDesign}
      />
      <PanelTabButton
        label={rendersLabel}
        tooltip="Render queue and exports"
        active={rendersActive}
        onClick={onRenders}
      />
    </div>
  );
}

export function StudioRightSidebarRail({ onShow }: { onShow: () => void }) {
  return (
    <div className="ml-0.5 flex w-10 flex-shrink-0 flex-col items-center rounded-lg border border-neutral-800/50 bg-neutral-950 pt-1">
      <RightSidebarToggleButton mode="show" onClick={onShow} />
    </div>
  );
}
