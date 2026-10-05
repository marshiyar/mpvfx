import {
  PREVIEW_AGENT_CHANNEL,
  PREVIEW_AGENT_VERSION,
  isPreviewAgentInit,
  isPreviewAgentRequest,
  type PreviewAgentCommand,
  type PreviewAgentReady,
  type PreviewElementState,
  type PreviewRect,
} from "../../../shared/preview/agentProtocol";
import { previewOriginFromIframe } from "../../player/lib/previewUrl";

const REQUEST_TIMEOUT_MS = 5000;

type PendingRequest = {
  command: PreviewAgentCommand;
  resolve: (result: PreviewElementState | PreviewElementState[] | null) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteRect(value: unknown): boolean {
  return isRecord(value) &&
    [value.x, value.y, value.width, value.height].every(
      (number) => typeof number === "number" && Number.isFinite(number),
    ) && (value.width as number) >= 0 && (value.height as number) >= 0;
}

function isBoundedStringMap(value: unknown, maxKeys: number, maxKeyLength: number, maxValueLength: number): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maxKeys && entries.every(([key, entry]) =>
    key.length <= maxKeyLength && typeof entry === "string" && entry.length <= maxValueLength,
  );
}

/** A preview can run arbitrary authored code, so its replies are data, never authority. */
export function isPreviewElementState(value: unknown): value is PreviewElementState {
  return isRecord(value) &&
    typeof value.handle === "string" && /^e[1-9]\d{0,8}$/.test(value.handle) &&
    typeof value.tag === "string" && value.tag.length <= 64 &&
    typeof value.id === "string" && value.id.length <= 512 &&
    typeof value.className === "string" && value.className.length <= 2048 &&
    typeof value.text === "string" && value.text.length <= 4096 &&
    isFiniteRect(value.rect) &&
    typeof value.visible === "boolean" &&
    (value.parent === null || (typeof value.parent === "string" && /^e[1-9]\d{0,8}$/.test(value.parent))) &&
    (value.selector === undefined || (typeof value.selector === "string" && value.selector.length <= 512)) &&
    (value.selectorIndex === undefined || (Number.isSafeInteger(value.selectorIndex) &&
      (value.selectorIndex as number) >= 0 && (value.selectorIndex as number) <= 1000)) &&
    typeof value.sourceFile === "string" && value.sourceFile.length <= 512 &&
    typeof value.compositionPath === "string" && value.compositionPath.length <= 512 &&
    isBoundedStringMap(value.dataAttributes, 32, 64, 512) &&
    isBoundedStringMap(value.inlineStyles, 64, 64, 256) &&
    isBoundedStringMap(value.computedStyles, 64, 64, 256);
}

function validResult(command: PreviewAgentCommand, result: unknown): result is PreviewElementState | PreviewElementState[] | null {
  if (command.kind === "snapshot") {
    return Array.isArray(result) && result.length <= (command.limit ?? 300) && result.every(isPreviewElementState);
  }
  return result === null || isPreviewElementState(result);
}

function sessionToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Convert a parent pointer to the preview's CSS pixel coordinate space. */
export function clientPointToPreview(
  iframe: HTMLIFrameElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = iframe.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  return {
    x: (clientX - rect.left) * (iframe.clientWidth || rect.width) / rect.width,
    y: (clientY - rect.top) * (iframe.clientHeight || rect.height) / rect.height,
  };
}

/** Convert agent geometry to viewport coordinates for selection chrome. */
export function previewRectToClient(
  iframe: HTMLIFrameElement,
  previewRect: PreviewRect,
): PreviewRect | null {
  const rect = iframe.getBoundingClientRect();
  const layoutWidth = iframe.clientWidth || rect.width;
  const layoutHeight = iframe.clientHeight || rect.height;
  if (layoutWidth <= 0 || layoutHeight <= 0) return null;
  return {
    x: rect.left + previewRect.x * rect.width / layoutWidth,
    y: rect.top + previewRect.y * rect.height / layoutHeight,
    width: previewRect.width * rect.width / layoutWidth,
    height: previewRect.height * rect.height / layoutHeight,
  };
}

/** One client belongs to one iframe. A navigation revokes every pending handle/request. */
export class PreviewAgentClient {
  private token = "";
  private nextId = 1;
  private ready = false;
  private disposed = false;
  private pending = new Map<number, PendingRequest>();
  private readyListeners = new Set<() => void>();
  private initRetry: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly iframe: HTMLIFrameElement) {
    window.addEventListener("message", this.onMessage);
    iframe.addEventListener("load", this.connect);
  }

  get isReady(): boolean { return this.ready; }

  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    if (this.ready) listener();
    return () => this.readyListeners.delete(listener);
  }

  /** Call on first load; subsequent iframe load events reconnect automatically. */
  connect = (): void => {
    if (this.disposed) return;
    this.stopInitRetry();
    this.rejectPending("Preview navigated");
    this.ready = false;
    this.token = sessionToken();
    this.nextId = 1;
    const origin = previewOriginFromIframe(this.iframe);
    if (!origin) return;
    const init = {
      channel: PREVIEW_AGENT_CHANNEL,
      version: PREVIEW_AGENT_VERSION,
      type: "init" as const,
      token: this.token,
    };
    if (!isPreviewAgentInit(init)) throw new Error("Invalid preview init");
    const sendInit = () => this.iframe.contentWindow?.postMessage(init, origin);
    sendInit();
    // The iframe load event can precede a deferred preview-runtime listener on
    // a warm navigation. Repeat the same handshake until the agent is ready;
    // never mint a new token or reuse one across a later navigation.
    let attempts = 0;
    this.initRetry = setInterval(() => {
      if (this.disposed || this.ready || this.token !== init.token ||
          previewOriginFromIframe(this.iframe) !== origin || ++attempts > 20) {
        this.stopInitRetry();
        return;
      }
      sendInit();
    }, 250);
  };

  request(command: PreviewAgentCommand): Promise<PreviewElementState | PreviewElementState[] | null> {
    if (this.disposed || !this.ready) return Promise.reject(new Error("Preview agent is not ready"));
    const id = this.nextId++;
    const request = {
      channel: PREVIEW_AGENT_CHANNEL,
      version: PREVIEW_AGENT_VERSION,
      type: "request" as const,
      token: this.token,
      id,
      command,
    };
    if (!isPreviewAgentRequest(request)) return Promise.reject(new Error("Invalid preview command"));
    const origin = previewOriginFromIframe(this.iframe);
    if (!origin) return Promise.reject(new Error("Preview origin is unavailable"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Preview agent timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { command, resolve, reject, timer });
      this.iframe.contentWindow?.postMessage(request, origin);
    });
  }

  hitTestAtClientPoint(clientX: number, clientY: number): Promise<PreviewElementState | null> {
    const point = clientPointToPreview(this.iframe, clientX, clientY);
    if (!point) return Promise.resolve(null);
    return this.request({ kind: "hitTest", ...point }).then(result =>
      result && !Array.isArray(result) ? result : null,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.stopInitRetry();
    this.rejectPending("Preview agent disposed");
    this.readyListeners.clear();
    this.iframe.removeEventListener("load", this.connect);
    window.removeEventListener("message", this.onMessage);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private stopInitRetry(): void {
    if (this.initRetry) clearInterval(this.initRetry);
    this.initRetry = null;
  }

  private onMessage = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.iframe.contentWindow ||
      event.origin !== previewOriginFromIframe(this.iframe)) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.channel !== PREVIEW_AGENT_CHANNEL ||
      data.version !== PREVIEW_AGENT_VERSION || data.token !== this.token) return;
    if (data.type === "ready") {
      if (Object.keys(data).length !== 4) return;
      const ready = data as PreviewAgentReady;
      if (ready.token !== this.token) return;
      this.ready = true;
      this.stopInitRetry();
      for (const listener of this.readyListeners) listener();
      return;
    }
    if (data.type !== "reply" || !Number.isSafeInteger(data.id)) return;
    const id = data.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (data.ok === false && ["invalid-request", "stale-handle", "unsupported-action"].includes(String(data.error))) {
      pending.reject(new Error(String(data.error)));
    } else if (data.ok === true && validResult(pending.command, data.result)) {
      pending.resolve(data.result);
    } else {
      pending.reject(new Error("Invalid preview agent reply"));
    }
  };
}

const clients = new WeakMap<HTMLIFrameElement, PreviewAgentClient>();

/** Makes the active player's bridge available to canvas controllers without a DOM read. */
export function attachPreviewAgent(iframe: HTMLIFrameElement): PreviewAgentClient {
  const existing = clients.get(iframe);
  if (existing) return existing;
  const client = new PreviewAgentClient(iframe);
  clients.set(iframe, client);
  window.dispatchEvent(new CustomEvent("mpvfx-preview-agent-attached", { detail: iframe }));
  return client;
}

export function detachPreviewAgent(iframe: HTMLIFrameElement): void {
  clients.get(iframe)?.dispose();
  clients.delete(iframe);
}

export function previewAgentForIframe(iframe: HTMLIFrameElement | null): PreviewAgentClient | null {
  return iframe ? clients.get(iframe) ?? null : null;
}
