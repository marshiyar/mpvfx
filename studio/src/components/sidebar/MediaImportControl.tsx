import { useRef } from "react";
import { MEDIA_IMPORT_ACCEPT } from "../../utils/mediaImportPolicy";

interface MediaImportControlProps {
  onImport: (files: FileList) => void | Promise<void>;
  importing?: boolean;
}

export function MediaImportControl({ onImport, importing = false }: MediaImportControlProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={MEDIA_IMPORT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) {
            void onImport(event.target.files);
            event.target.value = "";
          }
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={importing}
        aria-busy={importing}
        aria-label="Import media"
        title="Import media"
        className="flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-md bg-panel-input px-3 py-[7px] text-[11px] font-medium text-panel-text-3 transition-colors enabled:hover:text-panel-text-1 enabled:active:scale-[0.98] disabled:opacity-60"
      >
        {importing ? (
          <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        <span>{importing ? "Importing…" : "Import media"}</span>
      </button>
    </>
  );
}
