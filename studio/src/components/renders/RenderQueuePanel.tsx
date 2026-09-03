import { memo } from "react";
import { RenderQueue } from "./RenderQueue";
import type { RenderJob } from "./useRenderQueue";
import { useStudioShellContext } from "../../contexts/StudioContext";

/**
 * The Renders tab, wired to the shell context.
 *
 * Split out of StudioRightPanel because every field it needs already lives in
 * that context, so routing them through the panel only made the panel longer
 * without giving anything a second reader.
 */
export const RenderQueuePanel = memo(function RenderQueuePanel() {
  const { projectId, compositionDimensions, waitForPendingDomEditSaves, renderQueue } =
    useStudioShellContext();

  return (
    <RenderQueue
      jobs={renderQueue.jobs as RenderJob[]}
      projectId={projectId}
      onDelete={renderQueue.deleteRender}
      onCancel={renderQueue.cancelRender}
      loadError={renderQueue.loadError}
      onRetryLoad={renderQueue.reloadRenders}
      actionError={renderQueue.actionError}
      onDismissActionError={renderQueue.dismissActionError}
      onClearCompleted={renderQueue.clearCompleted}
      ffmpeg={renderQueue.ffmpeg}
      ffmpegChecking={renderQueue.ffmpegChecking}
      onRecheckFfmpeg={renderQueue.recheckFfmpeg}
      onStartRender={async (format, quality, outputTarget, fps) => {
        await waitForPendingDomEditSaves();
        // No `composition`: startRender targets the active one by default.
        await renderQueue.startRender({
          fps,
          quality,
          format,
          ...(typeof outputTarget === "string"
            ? { resolution: outputTarget }
            : { dimensions: outputTarget }),
        });
      }}
      compositionDimensions={compositionDimensions}
      isRendering={renderQueue.isRendering}
    />
  );
});
