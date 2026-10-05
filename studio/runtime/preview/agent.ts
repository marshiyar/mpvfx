import {
  PREVIEW_AGENT_CHANNEL,
  PREVIEW_AGENT_VERSION,
  isPreviewAgentInit,
  isPreviewAgentRequest,
  type PreviewAgentCommand,
  type PreviewAgentReply,
  type PreviewElementState,
} from "../../shared/preview/agentProtocol";

const MAX_ELEMENTS = 300;
const STYLE_PROPERTIES = new Set([
  "color", "background-color", "opacity", "visibility", "display", "overflow",
  "position", "left", "right", "top", "bottom", "width", "height",
  "min-width", "min-height", "max-width", "max-height", "z-index",
  "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
  "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
  "border", "border-color", "border-width", "border-radius", "box-shadow",
  "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
  "transform", "transform-origin",
]);
const ATTRIBUTES = new Set(["id", "class", "title", "alt", "aria-label"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "HEAD", "HTML"]);
const READ_STYLES = ["position", "left", "top", "width", "height", "transform", "transform-origin",
  "opacity", "display", "visibility", "z-index", "color", "background-color", "font-family",
  "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "border-radius"] as const;

export interface PreviewAgentOptions {
  /** The editor's exact origin, supplied by the preview host. Never use '*'. */
  parentOrigin: string;
  compositionPath?: string;
}

/**
 * A small, unprivileged DOM adapter. Authored scripts share this realm, so its
 * replies are observations, never proof that the authored document is honest.
 * It does not expose host APIs or intercept playback/runtime messages.
 */
export function installPreviewAgent(
  view: Window,
  document: Document,
  options: PreviewAgentOptions,
): () => void {
  if (!options.parentOrigin || options.parentOrigin === "*" || options.parentOrigin === "null") {
    throw new Error("Preview agent requires an exact parent origin");
  }
  let handles = new WeakMap<Element, string>();
  const elements = new Map<string, Element>();
  let nextHandle = 1;
  let token: string | null = null;
  let lastId = 0;

  const assign = (element: Element): string => {
    let id = handles.get(element);
    if (!id) {
      id = `e${nextHandle++}`;
      handles.set(element, id);
      elements.set(id, element);
    }
    return id;
  };
  const resolve = (id: string): Element | null => {
    const element = elements.get(id);
    if (!element || !element.isConnected || element.ownerDocument !== document) {
      elements.delete(id);
      return null;
    }
    return element;
  };
  const sourceFile = (element: Element): string => {
    const host = element.closest("[data-composition-file], [data-composition-src]");
    const root = element.closest("[data-composition-id]");
    return (host?.getAttribute("data-composition-file") ?? host?.getAttribute("data-composition-src")
      ?? root?.getAttribute("data-composition-file") ?? root?.getAttribute("data-composition-src")
      ?? options.compositionPath ?? "index.html").slice(0, 512);
  };
  const selectorFor = (element: Element): string | undefined => {
    const escape = (value: string) => globalThis.CSS?.escape?.(value) ?? value.replace(/[^\w-]/g, "\\$&");
    if (element.id) return `#${escape(element.id)}`.slice(0, 512);
    const compositionId = element.getAttribute("data-composition-id");
    if (compositionId) return `[data-composition-id="${compositionId.replace(/["\\]/g, "\\$&")}"]`.slice(0, 512);
    const group = element.getAttribute("data-hf-group");
    if (group) return `[data-hf-group="${group.replace(/["\\]/g, "\\$&")}"]`.slice(0, 512);
    const className = Array.from(element.classList).find(value => value !== "clip" && !value.startsWith("__hf-"));
    return className ? `.${escape(className)}`.slice(0, 512) : undefined;
  };
  const readStyles = (element: Element, computed: CSSStyleDeclaration): {
    inlineStyles: Record<string, string>; computedStyles: Record<string, string>;
  } => {
    const inlineStyles: Record<string, string> = {};
    const computedStyles: Record<string, string> = {};
    for (const property of READ_STYLES) {
      const inline = (element as HTMLElement).style?.getPropertyValue(property);
      const resolved = computed.getPropertyValue(property);
      if (inline) inlineStyles[property] = inline.slice(0, 256);
      if (resolved) computedStyles[property] = resolved.slice(0, 256);
    }
    return { inlineStyles, computedStyles };
  };
  const describe = (element: Element): PreviewElementState => {
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    const selector = selectorFor(element);
    let selectorIndex: number | undefined;
    if (selector?.startsWith(".")) {
      try {
        const peers = document.querySelectorAll(selector);
        for (let index = 0; index < Math.min(peers.length, 1000); index++) {
          if (peers[index] === element) { selectorIndex = index; break; }
        }
      } catch { /* The selector is advisory metadata. */ }
    }
    const dataAttributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      if (Object.keys(dataAttributes).length >= 32) break;
      if (attribute.name.startsWith("data-") && attribute.name.length <= 69) {
        dataAttributes[attribute.name.slice(5)] = attribute.value.slice(0, 512);
      }
    }
    const file = sourceFile(element);
    return {
      handle: assign(element),
      tag: element.tagName.toLowerCase(),
      id: element.id.slice(0, 256),
      className: (typeof element.className === "string" ? element.className : "").slice(0, 256),
      text: (element.textContent ?? "").slice(0, 256),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      parent: element.parentElement ? assign(element.parentElement) : null,
      selector,
      selectorIndex,
      sourceFile: file,
      compositionPath: file,
      dataAttributes,
      ...readStyles(element, style),
    };
  };
  const execute = (command: PreviewAgentCommand): PreviewAgentReply["result"] => {
    if (command.kind === "snapshot") {
      return Array.from(document.body?.querySelectorAll("*") ?? [])
        .filter(element => !SKIP_TAGS.has(element.tagName))
        .slice(command.offset ?? 0, (command.offset ?? 0) + (command.limit ?? MAX_ELEMENTS))
        .map(describe);
    }
    if (command.kind === "hitTest") {
      const hit = document.elementFromPoint(command.x, command.y);
      return hit && !SKIP_TAGS.has(hit.tagName) ? describe(hit) : null;
    }
    const element = resolve(command.handle);
    if (!element) throw new Error("stale-handle");
    if (command.kind === "readElement") return describe(element);
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
      throw new Error("unsupported-action");
    }
    if (command.kind === "setStyle") {
      if (!STYLE_PROPERTIES.has(command.property) || /url\s*\(|expression\s*\(|@import|[\u0000-\u001f]/i.test(command.value)) {
        throw new Error("unsupported-action");
      }
      (element as HTMLElement | SVGElement).style.setProperty(command.property, command.value);
    } else if (command.kind === "setText") {
      element.textContent = command.text;
    } else if (command.kind === "setAttribute") {
      if (!ATTRIBUTES.has(command.name)) throw new Error("unsupported-action");
      element.setAttribute(command.name, command.value);
    }
    return describe(element);
  };
  const send = (message: PreviewAgentReply | {
    channel: typeof PREVIEW_AGENT_CHANNEL;
    version: typeof PREVIEW_AGENT_VERSION;
    type: "ready";
    token: string;
  }): void => view.parent.postMessage(message, options.parentOrigin);
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== view.parent || event.origin !== options.parentOrigin) return;
    if (isPreviewAgentInit(event.data)) {
      token = event.data.token;
      lastId = 0;
      elements.clear();
      handles = new WeakMap<Element, string>();
      nextHandle = 1;
      // WeakMap entries from a previous channel are harmless because a fresh
      // handle is allocated below whenever their map entry is absent.
      send({ channel: PREVIEW_AGENT_CHANNEL, version: PREVIEW_AGENT_VERSION, type: "ready", token });
      return;
    }
    if (!isPreviewAgentRequest(event.data) || !token || event.data.token !== token || event.data.id <= lastId) return;
    lastId = event.data.id;
    const reply: PreviewAgentReply = {
      channel: PREVIEW_AGENT_CHANNEL,
      version: PREVIEW_AGENT_VERSION,
      type: "reply",
      token,
      id: event.data.id,
      ok: true,
    };
    try {
      reply.result = execute(event.data.command);
    } catch (error) {
      reply.ok = false;
      reply.error = error instanceof Error && (error.message === "stale-handle" || error.message === "unsupported-action")
        ? error.message : "invalid-request";
    }
    send(reply);
  };
  view.addEventListener("message", onMessage);
  return () => {
    view.removeEventListener("message", onMessage);
    elements.clear();
    token = null;
  };
}
