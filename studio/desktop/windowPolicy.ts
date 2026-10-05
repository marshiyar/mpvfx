export interface DesktopWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  backgroundColor: string;
  autoHideMenuBar: boolean;
  webPreferences: {
    preload?: string;
    additionalArguments?: string[];
    contextIsolation: true;
    /**
     * The preload loads the C++ engine module (native code), which a
     * sandboxed preload cannot do. The page itself still has no Node access:
     * contextIsolation stays on, nodeIntegration stays off, and the preload
     * exposes only the engine's pure functions and the desktop bridge.
     */
    sandbox: false;
    nodeIntegration: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    v8CacheOptions: "none";
  };
}

export const ENGINE_MODULE_ARGUMENT = "--vkf-engine-module=";

export function createWindowOptions(preload?: string, engineModulePath?: string): DesktopWindowOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      ...(preload ? { preload } : {}),
      ...(engineModulePath ? { additionalArguments: [`${ENGINE_MODULE_ARGUMENT}${engineModulePath}`] } : {}),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      v8CacheOptions: "none",
    },
  };
}

interface NavigationEvent {
  preventDefault(): void;
}

interface GuardedWebContents {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "allow" | "deny" },
  ): void;
  on(event: string, handler: (event: NavigationEvent, url: string) => void): void;
}

function sameOrigin(url: string, allowedOrigin: string): boolean {
  try {
    const target = new URL(url);
    const allowed = new URL(allowedOrigin);
    return !target.username && !target.password && !target.port &&
      target.protocol === allowed.protocol && target.host === allowed.host &&
      target.pathname === "/";
  } catch {
    return false;
  }
}

/** Fullscreen belongs to the editor pane; embedded project documents get no permissions. */
export function isEditorFullscreenRequest(
  permission: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
  editorOrigin: string | null | undefined,
): boolean {
  return permission === "fullscreen" && details.isMainFrame && !!details.requestingUrl &&
    !!editorOrigin && sameOrigin(details.requestingUrl, editorOrigin);
}

/** Only the app entry route may navigate the privileged window. */
export function installWindowGuards(
  webContents: GuardedWebContents,
  allowedOrigin: string,
): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const preventExternalNavigation = (event: NavigationEvent, url: string) => {
    if (!sameOrigin(url, allowedOrigin)) event.preventDefault();
  };
  webContents.on("will-navigate", preventExternalNavigation);
  webContents.on("will-redirect", preventExternalNavigation);
}
