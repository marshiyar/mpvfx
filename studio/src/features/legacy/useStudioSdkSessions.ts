import { useSdkSession } from "./useSdkSession";

/**
 * Open the SDK session used by the editor's timeline and visual edit adapters.
 */
export function useStudioSdkSessions(
  projectId: string | null,
  activeCompPath: string | null,
) {
  const sdkHandle = useSdkSession(projectId, activeCompPath);
  const editFlowSdkSession = activeCompPath ? sdkHandle.session : null;
  return { sdkHandle, editFlowSdkSession };
}
