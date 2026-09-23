import { DESKTOP_ORIGIN, type DesktopBridge } from "../../shared/desktopBridge";

declare global {
  interface Window { mpvfx: DesktopBridge }
}

/** Serialize browser bodies (including multipart uploads) for Electron IPC. */
export async function desktopRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : new URL(String(input), `${DESKTOP_ORIGIN}/`).href;
  const request = new Request(input instanceof Request ? input : url, init);
  const target = new URL(request.url);
  if (target.protocol !== "mpvfx:" || target.host !== "editor" || !target.pathname.startsWith("/api/")) {
    throw new Error("Desktop commands require a local /api/ path");
  }
  request.signal.throwIfAborted();
  const body = request.body ? await request.arrayBuffer() : undefined;
  request.signal.throwIfAborted();
  const id = crypto.randomUUID();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    try { window.mpvfx.cancel(id); }
    finally { rejectAbort(request.signal.reason); }
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([window.mpvfx.request({
      id, path: target.pathname + target.search, method: request.method,
      headers: Array.from(request.headers.entries()), body,
    }), aborted]);
    request.signal.throwIfAborted();
    return new Response(response.body, response);
  } catch (error) {
    request.signal.throwIfAborted();
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}

/** File changes and render progress arrive over IPC, without event-stream connections. */
export class DesktopEvents {
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  private readonly unsubscribe: () => void;

  constructor(path: string) {
    this.unsubscribe = window.mpvfx.subscribe(path, (event) => {
      if (event.type === "error") this.onerror?.();
      for (const listener of this.listeners.get(event.type) ?? []) {
        listener(new MessageEvent(event.type, { data: event.data }));
      }
    });
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.onerror = null;
  }
}
