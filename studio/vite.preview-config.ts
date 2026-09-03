export type PreviewConfigEnv = Record<string, string | undefined>;
const ADAPTER_RUNTIME_FLAG = ["isHyper", "frames"].join("");

export function previewConfigPayload(
  env: PreviewConfigEnv,
  pid = process.pid,
  version = "dev",
): Record<string, unknown> | null {
  const projectDir = env.HYPERFRAMES_PREVIEW_PROJECT_DIR;
  const projectName = env.HYPERFRAMES_PREVIEW_PROJECT_NAME;
  if (!projectDir || !projectName) return null;

  const browserGpuMode = env.HYPERFRAMES_PREVIEW_BROWSER_GPU_MODE;
  return {
    [ADAPTER_RUNTIME_FLAG]: true,
    pid,
    projectName,
    projectDir,
    serverBuildSignature: null,
    ...(browserGpuMode ? { browserGpuMode } : {}),
    version,
  };
}
