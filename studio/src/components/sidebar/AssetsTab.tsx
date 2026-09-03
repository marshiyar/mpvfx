// fallow-ignore-file code-duplication
import { memo, useState, useCallback, useRef, useMemo, useEffect } from "react";
import { SearchInput } from "../ui/SearchInput";
import { MEDIA_EXT, FONT_EXT } from "../../utils/mediaTypes";
import { buildProjectApiPath } from "../../utils/projectRouting";
import { copyTextToClipboard } from "../../utils/clipboard";
import { usePlayerStore } from "../../player/store/playerStore";
import {
  type MediaCategory,
  type CopyFeedback,
  getCategory,
  basename,
  CATEGORY_LABELS,
  FILTER_ORDER,
} from "./assetHelpers";
import { AudioRow } from "./AudioRow";
import { AssetCard, FontRow } from "./AssetCard";

interface AssetsTabProps {
  projectId: string;
  assets: string[];
  onImport?: (files: FileList) => void | Promise<void>;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

/**
 * Project-relative asset paths referenced by composition elements — the set the
 * "in use" badge and used-first sort key on. Element src is
 * populated from the core runtime's `resolveNodeAssetUrl` which calls
 * `new URL(raw, document.baseURI).toString()`, turning authored relative paths
 * into fully-absolute URLs with percent-encoded characters, e.g.
 *   "assets/my file (1).mp4"
 *   → "http://localhost:3012/api/projects/demo/preview/assets/my%20file%20(1).mp4"
 *
 * This function normalizes every src shape to the bare project-relative path so
 * it matches the asset-list entries:
 *   - Absolute URL  → strip origin + /api/projects/<id>/preview/ prefix, decode %XX
 *   - Server-relative /api/…preview/… → same strip + decode
 *   - Relative "./"-prefixed or bare → strip leading ./ or /
 *   - ?query / #hash → dropped
 *
 * Pure — unit-tested.
 */
export function deriveUsedPaths(elements: Array<{ src?: string }>): Set<string> {
  const paths = new Set<string>();
  for (const el of elements) {
    if (!el.src) continue;
    let s = el.src;

    // Strip absolute origin if present (http://host/path → /path)
    try {
      const u = new URL(s);
      s = u.pathname + (u.search ? u.search : "") + (u.hash ? u.hash : "");
    } catch {
      // Not a valid absolute URL — leave as-is (relative path)
    }

    s = s
      .replace(/^\/api\/projects\/[^/]+\/preview\//, "") // strip the dev serve prefix
      .replace(/^\.?\//, "") // strip leading ./ or /
      .split(/[?#]/)[0]; // drop query / hash

    // Decode percent-encoded characters (spaces, parens, etc.) so the path
    // matches the plain-text asset-list entries the server returns.
    try {
      s = decodeURIComponent(s);
    } catch {
      // Malformed encoding — use as-is
    }

    if (s) paths.add(s);
  }
  return paths;
}

/** Empty list body. A query that matched nothing says so and offers a way out;
 *  a genuinely empty project gets the drop hint. */
function EmptyState({
  searchQuery,
  onClearSearch,
}: {
  searchQuery: string;
  onClearSearch: () => void;
}) {
  if (searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 gap-2">
        <p className="text-[11px] text-neutral-500 text-center">
          No assets match &ldquo;{searchQuery}&rdquo;
        </p>
        <button
          type="button"
          onClick={onClearSearch}
          className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-panel-input text-panel-text-3 hover:text-panel-text-1 active:scale-[0.98] transition-colors"
        >
          Clear search
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 gap-2">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-neutral-700"
      >
        <path
          d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline points="17 8 12 3 7 8" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="12" y1="3" x2="12" y2="15" strokeLinecap="round" />
      </svg>
      <p className="text-[10px] text-neutral-600 text-center">Drop media files here</p>
    </div>
  );
}

export const AssetsTab = memo(function AssetsTab({
  projectId,
  assets,
  onImport,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: AssetsTabProps) {
  const [dragOver, setDragOver] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [manifest, setManifest] = useState<
    Map<string, { description?: string; duration?: number; width?: number; height?: number }>
  >(new Map());

  const manifest404Ref = useRef<Set<string>>(new Set());
  const assetsKey = assets.join("|");
  useEffect(() => {
    if (manifest404Ref.current.has(projectId)) return;
    let cancelled = false;
    fetch(buildProjectApiPath(projectId, "/preview/.media/manifest.jsonl"))
      .then((r) => {
        if (!r.ok) {
          manifest404Ref.current.add(projectId);
          return "";
        }
        return r.text();
      })
      .then((text) => {
        if (cancelled || !text) return;
        const m = new Map<
          string,
          { description?: string; duration?: number; width?: number; height?: number }
        >();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.path) m.set(rec.path, rec);
          } catch {
            /* skip */
          }
        }
        setManifest(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, assetsKey]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) void onImport?.(e.dataTransfer.files);
    },
    [onImport],
  );

  const handleCopyPath = useCallback(async (path: string) => {
    const copied = await copyTextToClipboard(path);
    setCopyFeedback({ path, ok: copied });
    setTimeout(() => setCopyFeedback(null), copied ? 1500 : 3000);
  }, []);
  const elements = usePlayerStore((s) => s.elements);
  const usedPaths = useMemo(() => deriveUsedPaths(elements), [elements]);

  // Unfiltered pool — search is gated on THIS, not
  // the search-filtered list, so a no-match query can't unmount its own input.
  const allMediaAssets = useMemo(
    () => assets.filter((a) => MEDIA_EXT.test(a) || FONT_EXT.test(a)),
    [assets],
  );

  const mediaAssets = useMemo(() => {
    if (!searchQuery) return allMediaAssets;
    const q = searchQuery.toLowerCase();
    return allMediaAssets.filter((a) => {
      if (basename(a).toLowerCase().includes(q)) return true;
      const rec = manifest.get(a);
      return rec?.description?.toLowerCase().includes(q);
    });
  }, [allMediaAssets, searchQuery, manifest]);

  const categorized = useMemo(() => {
    const groups: Record<MediaCategory, string[]> = { audio: [], images: [], video: [], fonts: [] };
    for (const a of mediaAssets) {
      const cat = getCategory(a);
      if (cat) groups[cat].push(a);
    }
    // Sort: used assets first within each category
    for (const cat of FILTER_ORDER) {
      groups[cat].sort((a, b) => {
        const aUsed = usedPaths.has(a) ? 0 : 1;
        const bUsed = usedPaths.has(b) ? 0 : 1;
        return aUsed - bUsed;
      });
    }
    return groups;
  }, [mediaAssets, usedPaths]);
  const visibleCategories = FILTER_ORDER.filter((category) => categorized[category].length > 0);
  return (
    <div
      className={`flex-1 flex flex-col min-h-0 transition-colors ${dragOver ? "bg-studio-accent/[0.05]" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header — matches design panel Section pattern */}
      <div className="px-4 pt-2.5 pb-1.5 flex-shrink-0">
        {/* Search — gated on the UNFILTERED pool so it never unmounts itself */}
        {allMediaAssets.length > 0 && (
          <SearchInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search assets..."
            aria-label="Search assets"
            className="mb-2"
          />
        )}

      </div>

      <div className="flex-1 overflow-y-auto mt-1">
        {mediaAssets.length === 0 ? (
          <EmptyState searchQuery={searchQuery} onClearSearch={() => setSearchQuery("")} />
        ) : (
          visibleCategories.map((cat) => (
            <div key={cat} className="mb-1">
              <div className="flex items-center gap-2 px-4 py-2 border-t border-panel-border">
                <h3 className="text-[12px] font-semibold text-panel-text-1">
                  {CATEGORY_LABELS[cat]}
                </h3>
                <span className="text-[11px] text-panel-text-5">{categorized[cat].length}</span>
              </div>
              {cat === "audio" &&
                categorized[cat].map((a) => (
                  <AudioRow
                    key={a}
                    projectId={projectId}
                    asset={a}
                    used={usedPaths.has(a)}
                    meta={manifest.get(a)}
                    onCopy={handleCopyPath}
                    copyFeedback={copyFeedback}
                    onDelete={onDelete}
                    onRename={onRename}
                    onAddAssetToTimeline={onAddAssetToTimeline}
                  />
                ))}
              {(cat === "images" || cat === "video") && (
                <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                  {categorized[cat].map((a) => (
                    <AssetCard
                      key={a}
                      projectId={projectId}
                      asset={a}
                      used={usedPaths.has(a)}
                      duration={manifest.get(a)?.duration}
                      onCopy={handleCopyPath}
                      copyFeedback={copyFeedback}
                      onDelete={onDelete}
                      onRename={onRename}
                      onAddAssetToTimeline={onAddAssetToTimeline}
                    />
                  ))}
                </div>
              )}
              {cat === "fonts" &&
                categorized[cat].map((a) => (
                  <FontRow
                    key={a}
                    asset={a}
                    used={usedPaths.has(a)}
                    onCopy={handleCopyPath}
                    copyFeedback={copyFeedback}
                    onDelete={onDelete}
                    onRename={onRename}
                    onAddAssetToTimeline={onAddAssetToTimeline}
                  />
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
