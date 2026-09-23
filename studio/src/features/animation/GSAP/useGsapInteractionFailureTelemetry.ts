import { useCallback } from "react";
import type { DomEditSelection } from "../../canvas/domEditing";
import {
  trackStudioEditBlocked,
  trackStudioSaveFailure,
} from "../../history/studioSaveDiagnostics";
import { isGsapEditBlockedError } from "./gsapEditOutcome";

export function useGsapInteractionFailureTelemetry(
  activeCompPath: string | null,
  showToast: (message: string, tone?: "error" | "info") => void,
) {
  return useCallback(
    (
      error: unknown,
      selection: DomEditSelection | null,
      mutationType: string,
      label: string,
    ) => {
      const report = isGsapEditBlockedError(error)
        ? trackStudioEditBlocked
        : trackStudioSaveFailure;
      report({
        source: "gsap_commit",
        error,
        filePath: selection?.sourceFile ?? activeCompPath ?? "index.html",
        mutationType,
        label,
        targetId: selection?.id,
        targetSelector: selection?.selector,
        targetSourceFile: selection?.sourceFile,
      });
      showToast(
        isGsapEditBlockedError(error)
          ? error.message
          : `Couldn’t save ${label}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    },
    [activeCompPath, showToast],
  );
}
