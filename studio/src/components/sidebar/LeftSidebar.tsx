import {
  memo,
  useState,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  forwardRef,
  type ReactNode,
} from "react";
import { CompositionsTab } from "./CompositionsTab";
import { AssetsTab } from "./AssetsTab";
import { trackStudioEvent } from "../../utils/studioTelemetry";
import { safeLocalStorage } from "../../utils/safeStorage";
import { BlocksTab, type BlockPreviewInfo } from "./BlocksTab";
import { Tooltip } from "../ui";
import { useBlockCatalog } from "../../hooks/useBlockCatalog";
import { MediaImportControl } from "./MediaImportControl";

export type SidebarTab = "compositions" | "assets" | "blocks";

export interface LeftSidebarHandle {
  selectTab: (tab: SidebarTab) => void;
  getTab: () => SidebarTab;
}

const STORAGE_KEY = "hf-studio-sidebar-tab";

const SIDEBAR_TABS: Array<{ id: SidebarTab; label: string; tooltip: string }> = [
  { id: "assets", label: "Media", tooltip: "Import videos, images, audio, and fonts" },
  { id: "compositions", label: "Scenes", tooltip: "Reusable scenes and nested sequences" },
  { id: "blocks", label: "Elements", tooltip: "Browse reusable visual elements" },
];

export function getSidebarTabs(
  availability: { hasScenes?: boolean; hasElements?: boolean } = {},
): ReadonlyArray<{
  id: SidebarTab;
  label: string;
  tooltip: string;
}> {
  const { hasScenes = true, hasElements = true } = availability;
  return SIDEBAR_TABS.filter(
    (tab) =>
      tab.id === "assets" ||
      (tab.id === "compositions" && hasScenes) ||
      (tab.id === "blocks" && hasElements),
  );
}

// Both the `localStorage` reference and `getItem` itself can throw when the
// browsing context is partitioned or site data is blocked — the same case
// telemetry/config.ts documents. This runs as a `useState` initializer, so an
// unguarded throw here takes the whole editor to the crash boundary rather
// than losing one remembered tab.
export function getPersistedTab(): SidebarTab {
  let stored: string | null = null;
  try {
    stored = safeLocalStorage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    /* storage unavailable — fall back to the default tab */
  }
  if (stored === "assets") return "assets";
  if (stored === "blocks") return "blocks";
  return "assets";
}

interface LeftSidebarProps {
  width?: number;
  projectId: string;
  compositions: string[];
  masterComposition?: string | null;
  assets: string[];
  activeComposition: string | null;
  onSelectComposition: (comp: string) => void;
  onImportFiles?: (files: FileList, dir?: string) => void | Promise<void>;
  onDeleteFile?: (path: string) => void;
  onDeleteComposition?: (path: string) => void | Promise<unknown>;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onRenderComposition?: (comp: string) => void;
  isRendering?: boolean;
  onToggleCollapse?: () => void;
  onAddBlock?: (blockName: string) => void | Promise<void>;
  onPreviewBlock?: (preview: BlockPreviewInfo | null) => void;
  takeoverContent?: ReactNode;
  onAddAssetToTimeline?: (path: string) => void;
  onAddCompositionToTimeline?: (path: string) => void;
}

export const LeftSidebar = memo(
  forwardRef<LeftSidebarHandle, LeftSidebarProps>(function LeftSidebar(
    {
      width = 240,
      projectId,
      compositions,
      masterComposition,
      assets,
      activeComposition,
      onSelectComposition,
      onImportFiles,
      onDeleteFile,
      onDeleteComposition,
      onRenameFile,
      onRenderComposition,
      isRendering,
      onToggleCollapse,
      onAddBlock,
      onPreviewBlock,
      takeoverContent,
      onAddAssetToTimeline,
      onAddCompositionToTimeline,
    },
    ref,
  ) {
    const { blocks } = useBlockCatalog();
    const availableTabs = useMemo(
      () =>
        getSidebarTabs({
          hasScenes:
            Boolean(masterComposition) &&
            compositions.some((composition) => composition !== masterComposition),
          hasElements: blocks.length > 0,
        }),
      [blocks.length, compositions, masterComposition],
    );
    const [tab, setTab] = useState<SidebarTab>(getPersistedTab);
    const [importing, setImporting] = useState(false);
    const tabRef = useRef(tab);
    tabRef.current = tab;
    const tablistRef = useRef<HTMLDivElement>(null);

    const selectTab = useCallback((t: SidebarTab) => {
      setTab(t);
      try {
        safeLocalStorage()?.setItem(STORAGE_KEY, t);
      } catch {
        /* storage unavailable — the tab just won't be remembered */
      }
      trackStudioEvent("tab_switch", { panel: "left_sidebar", tab: t });
    }, []);

    const getTab = useCallback(() => tabRef.current, []);

    useImperativeHandle(ref, () => ({ selectTab, getTab }), [selectTab, getTab]);

    useEffect(() => {
      if (!availableTabs.some((available) => available.id === tab)) selectTab("assets");
    }, [availableTabs, selectTab, tab]);

    const handleImportFiles = useCallback(
      async (files: FileList) => {
        if (!onImportFiles) return;
        setImporting(true);
        try {
          await onImportFiles(files);
        } finally {
          setImporting(false);
        }
      },
      [onImportFiles],
    );

    // APG tabs pattern: Left/Right move focus AND selection between tabs.
    const handleTablistKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const ids = availableTabs.map((t) => t.id);
        const idx = ids.indexOf(tabRef.current);
        const next = ids[(idx + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
        selectTab(next);
        tablistRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${next}"]`)?.focus();
      },
      [availableTabs, selectTab],
    );

    return (
      <div
        className="flex flex-col h-full overflow-hidden rounded-lg border border-neutral-800/50 bg-neutral-950"
        style={{ width }}
      >
        {takeoverContent ? (
          <div className="flex min-h-0 flex-1">{takeoverContent}</div>
        ) : (
          <>
            {/* Media-first editor navigation. */}
            {(availableTabs.length > 1 || onToggleCollapse || onImportFiles) && (
            <div className="border-b border-neutral-800/50 px-3 py-3 flex-shrink-0">
              <div
                className={`flex items-center gap-2 ${availableTabs.length === 1 ? "justify-end" : ""}`}
              >
                {availableTabs.length > 1 && (
                <div
                  ref={tablistRef}
                  role="tablist"
                  aria-label="Sidebar panels"
                  onKeyDown={handleTablistKeyDown}
                  className="grid min-w-0 flex-1 gap-0.5 rounded-[18px] border border-neutral-800 bg-neutral-900 p-1"
                  style={{ gridTemplateColumns: `repeat(${availableTabs.length}, minmax(0, 1fr))` }}
                >
                  {availableTabs.map((t) => (
                    <Tooltip key={t.id} label={t.tooltip} side="bottom">
                      <button
                        type="button"
                        role="tab"
                        data-tab-id={t.id}
                        aria-selected={tab === t.id}
                        aria-controls={`sidebar-panel-${t.id}`}
                        tabIndex={tab === t.id ? 0 : -1}
                        onClick={() => selectTab(t.id)}
                        className={`rounded-[14px] px-1.5 py-2 text-[10px] font-semibold truncate transition-all active:scale-[0.97] ${
                          tab === t.id
                            ? "bg-neutral-800 text-white"
                            : "text-neutral-500 hover:text-neutral-200"
                        }`}
                      >
                        {t.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
                )}
                {tab === "assets" && onImportFiles && (
                  <MediaImportControl onImport={handleImportFiles} importing={importing} />
                )}
                {onToggleCollapse && (
                  <button
                    type="button"
                    onClick={onToggleCollapse}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-transparent text-neutral-500 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300"
                    title="Hide sidebar"
                    aria-label="Hide sidebar"
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
                      <path d="m14 7-5 5 5 5" />
                      <path d="M19 4v16" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            )}

            {/* Tab content */}
            {tab === "compositions" && availableTabs.some((item) => item.id === "compositions") && (
              <div
                id="sidebar-panel-compositions"
                role="tabpanel"
                className="flex flex-col flex-1 min-h-0"
              >
                <CompositionsTab
                  projectId={projectId}
                  compositions={compositions}
                  masterComposition={masterComposition}
                  activeComposition={activeComposition}
                  onSelect={onSelectComposition}
                  onAddToTimeline={onAddCompositionToTimeline}
                  onRenderComposition={onRenderComposition}
                  onDeleteComposition={onDeleteComposition}
                  isRendering={isRendering}
                />
              </div>
            )}
            {tab === "assets" && (
              <div
                id="sidebar-panel-assets"
                role="tabpanel"
                className="flex flex-col flex-1 min-h-0"
              >
                <AssetsTab
                  projectId={projectId}
                  assets={assets}
                  onImport={onImportFiles ? handleImportFiles : undefined}
                  onDelete={onDeleteFile}
                  onRename={onRenameFile}
                  onAddAssetToTimeline={onAddAssetToTimeline}
                />
              </div>
            )}
            {tab === "blocks" && availableTabs.some((item) => item.id === "blocks") && (
              <div
                id="sidebar-panel-blocks"
                role="tabpanel"
                className="flex flex-col flex-1 min-h-0"
              >
                <BlocksTab onAddBlock={onAddBlock} onPreviewBlock={onPreviewBlock} />
              </div>
            )}

          </>
        )}
      </div>
    );
  }),
);
