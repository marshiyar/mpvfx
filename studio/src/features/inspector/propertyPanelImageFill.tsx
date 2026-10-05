import { classifyMediaImportPath, IMAGE_IMPORT_ACCEPT } from "../../../shared/media/mediaImportPolicy";
import { encodeMediaPath, projectMediaUrl } from "../../../shared/media/mediaUrl";
import { useMemo, useRef, useState } from "react";
import { Plus } from "../../icons/SystemIcons";
import { FIELD, LABEL } from "./propertyPanelHelpers";
import { DetailField } from "./propertyPanelPrimitives";
import { useTrackDesignInput } from "./DesignPanelInputContext";

/* ------------------------------------------------------------------ */
/*  Asset path helpers                                                 */
/* ------------------------------------------------------------------ */

function normalizeProjectPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function pathFromImageUrl(value: string): string | null {
  try {
    const url = new URL(value, "mpvfx://editor/");
    return normalizeProjectPath(decodeURIComponent(url.pathname));
  } catch { return null; }
}

function toRelativeProjectAssetPath(
  sourceFile: string,
  assetPath: string,
): string {
  const fromParts = normalizeProjectPath(sourceFile).split("/").filter(Boolean);
  const targetParts = normalizeProjectPath(assetPath)
    .split("/")
    .filter(Boolean);
  fromParts.pop();
  while (
    fromParts.length > 0 &&
    targetParts.length > 0 &&
    fromParts[0] === targetParts[0]
  ) {
    fromParts.shift();
    targetParts.shift();
  }
  return [...fromParts.map(() => ".."), ...targetParts].join("/") || assetPath;
}

function toProjectRootAssetPath(assetPath: string): string {
  return encodeMediaPath(normalizeProjectPath(assetPath));
}

function resolveSelectedAsset(
  imageUrl: string,
  sourceFile: string,
  assets: string[],
): string | null {
  const normalizedUrl = pathFromImageUrl(imageUrl);
  if (!normalizedUrl) return null;
  for (const asset of assets) {
    const normalizedAsset = normalizeProjectPath(asset);
    const relativeAsset = toRelativeProjectAssetPath(sourceFile, asset);
    if (
      normalizedUrl === normalizedAsset ||
      normalizedUrl === relativeAsset ||
      normalizedUrl.endsWith(`/${normalizedAsset}`) ||
      normalizedUrl.endsWith(`/${relativeAsset}`)
    ) {
      return asset;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  ImageFillField                                                     */
/* ------------------------------------------------------------------ */

export function ImageFillField({
  projectId,
  sourceFile,
  value,
  assets,
  disabled,
  onCommit,
  onImportAssets,
}: {
  projectId: string;
  sourceFile: string;
  value: string;
  assets: string[];
  disabled?: boolean;
  onCommit: (nextValue: string) => void;
  onImportAssets?: (files: FileList) => Promise<string[]>;
}) {
  const track = useTrackDesignInput();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const imageAssets = useMemo(
    () => assets.filter((a) => classifyMediaImportPath(a) === "image"),
    [assets],
  );
  const selectedAsset = useMemo(
    () => resolveSelectedAsset(value, sourceFile, imageAssets),
    [imageAssets, sourceFile, value],
  );
  // Existing URL fills remain editable, but new fills use the project asset
  // picker instead of presenting a second, empty source field.
  // Callers pass the URL extracted from the CSS fill, or an empty string.
  const externalUrlValue = selectedAsset ? "" : value.trim();

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !onImportAssets) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await onImportAssets(files);
      const nextImage = uploaded.find((a) => classifyMediaImportPath(a) === "image");
      if (nextImage) {
        track("button", "Upload image");
        onCommit(`url("${toProjectRootAssetPath(nextImage)}")`);
      }
    } catch {
      setUploadError("Upload failed — check the file and try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className={LABEL}>Project asset</span>
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => fileInputRef.current?.click()}
            className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 text-[11px] font-medium text-neutral-300 transition-colors ${
              disabled || uploading
                ? "cursor-not-allowed text-neutral-600"
                : "cursor-pointer hover:border-neutral-600 hover:text-white"
            }`}
          >
            <Plus size={12} className="flex-shrink-0" />
            <span className="truncate">
              {uploading ? "Uploading…" : "Upload image"}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_IMPORT_ACCEPT}
            aria-label="Upload image asset"
            disabled={disabled || uploading}
            className="hidden"
            onChange={async (event) => {
              await handleUpload(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        {uploadError && (
          <div className="text-[10px] text-red-400" role="alert">
            {uploadError}
          </div>
        )}
        {imageAssets.length > 0 ? (
          <div className="space-y-3">
            {selectedAsset && (
              <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/80">
                <img
                  src={projectMediaUrl(projectId, selectedAsset)}
                  alt={selectedAsset.split("/").pop() ?? selectedAsset}
                  className="h-28 w-full object-contain bg-neutral-950/80"
                />
              </div>
            )}
            <div className={FIELD}>
              <select
                value={selectedAsset ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const next = e.target.value;
                  track("select", "Project asset");
                  if (!next) {
                    onCommit("none");
                    return;
                  }
                  onCommit(`url("${toProjectRootAssetPath(next)}")`);
                }}
                className="min-w-0 w-full appearance-none bg-transparent text-[11px] font-medium text-neutral-100 outline-none disabled:cursor-not-allowed disabled:text-neutral-600"
              >
                <option value="">None</option>
                {imageAssets.map((asset) => (
                  <option key={asset} value={asset}>
                    {asset}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/50 px-3 py-3 text-[11px] leading-5 text-neutral-500">
            No image assets yet. Upload one here and Studio will also add it to
            the Assets tab.
          </div>
        )}
      </div>

      {externalUrlValue && (
        <DetailField
          label="Existing image URL"
          value={externalUrlValue}
          disabled={disabled}
          onCommit={(next) =>
            onCommit(next.trim() ? `url("${next.trim()}")` : "none")
          }
        />
      )}
    </div>
  );
}
