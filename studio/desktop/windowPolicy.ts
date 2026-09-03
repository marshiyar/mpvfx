export interface DesktopWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  backgroundColor: string;
  autoHideMenuBar: boolean;
  webPreferences: {
    contextIsolation: true;
    sandbox: true;
    nodeIntegration: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    v8CacheOptions: "none";
  };
}

/** BrowserWindow policy kept pure so a security regression does not need Electron to test. */
export function createWindowOptions(): DesktopWindowOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
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
    return new URL(url).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

/** Keep project HTML and imported content from navigating the privileged app window. */
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
