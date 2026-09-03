export interface EditorRendererSession {
  clearCache(): Promise<void>;
  clearCodeCaches(options: { urls?: string[] }): Promise<void>;
}

/**
 * The packaged editor is served from loopback. Clear Chromium's persisted HTTP
 * and compiled-JavaScript caches before the first window loads so replacing an
 * installed app can never execute UI code retained from an older bundle.
 * Project data and localStorage are intentionally untouched.
 */
export async function prepareEditorRendererSession(
  rendererSession: EditorRendererSession,
): Promise<void> {
  await Promise.all([
    rendererSession.clearCache(),
    rendererSession.clearCodeCaches({}),
  ]);
}
