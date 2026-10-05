import {
  PREVIEW_AGENT_CHANNEL,
  PREVIEW_AGENT_VERSION,
  isPreviewAgentInit,
  isPreviewAgentRequest,
  PREVIEW_TRANSPORT_KEYS,
  type PreviewAgentCommand,
  type PreviewAgentReply,
  type PreviewElementState,
  type PreviewTransportKeyEvent,
} from "../../../shared/preview/agentProtocol";
import type { VkfEngine } from "../../../shared/engine/vkfEngine";
import { installNativeProjectRuntime, type NativeProjectRuntime } from "../project/nativeProjectRuntime";
import { readPreviewGsapObservation } from "./gsapObservation";
import { prepareBakedNativeProject, restorePreviewEngine } from "./bakedNativeProject";
import { parseAudioFxChain } from "@hyperframes/core/audio-fx";
import { parseAutomation } from "@hyperframes/core/audio-automation";

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
const SIMPLE_CROP_PATH = /^inset\(\s*\d+(?:\.\d{1,4})?px(?:\s+\d+(?:\.\d{1,4})?px){3}(?:\s+round\s+\d+(?:\.\d{1,4})?px)?\s*\)$/;
const ATTRIBUTES = new Set(["id", "class", "title", "alt", "aria-label"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "HEAD", "HTML"]);
const READ_STYLES = ["position", "left", "top", "width", "height", "overflow", "transform", "transform-origin",
  "opacity", "display", "visibility", "z-index", "color", "background-color", "font-family",
  "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "border-radius", "clip-path",
  "border-color", "border-width", "border-style", "box-shadow", "filter", "backdrop-filter",
  "mix-blend-mode", "background-image", "object-fit", "object-position", "text-transform", "font-style"] as const;

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
  let nativeRuntime: NativeProjectRuntime | null = null;
  let nativePlaybackRate = 1;
  let originalEngine: VkfEngine | null | undefined;
  let scrubAudio: HTMLAudioElement | null = null;
  let scrubMuted = false;
  let scrubVolume = 1;
  let scrubTimer: ReturnType<typeof setTimeout> | null = null;
  const stopScrub = (): void => {
    if (scrubTimer) clearTimeout(scrubTimer);
    scrubTimer = null;
    if (!scrubAudio) return;
    try {
      scrubAudio.pause();
      scrubAudio.muted = scrubMuted;
      scrubAudio.volume = scrubVolume;
    } catch { /* A removed media node is already stopped. */ }
    scrubAudio = null;
  };

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
    // A composition host lives in its parent's source file. Its children live
    // in the file named on the host after the runtime expands that file.
    const scope = element.matches("[data-composition-file], [data-composition-src]")
      ? element.parentElement : element;
    const host = scope?.closest("[data-composition-file], [data-composition-src]");
    const root = scope?.closest("[data-composition-id]");
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
        // The authored color grade is a structured preset, usually larger than
        // ordinary element metadata. Keep it bounded while allowing a saved
        // preset to round-trip through the inspector.
        dataAttributes[attribute.name.slice(5)] = attribute.value.slice(0,
          attribute.name === "data-color-grading" ? 4096 : 512);
      }
    }
    const file = sourceFile(element);
    return {
      handle: assign(element),
      tag: element.tagName.toLowerCase(),
      id: element.id.slice(0, 256),
      className: (typeof element.className === "string" ? element.className : "").slice(0, 256),
      text: (element.textContent ?? "").slice(0, 256),
      textEditable: element instanceof HTMLElement && (element.textContent?.length ?? 0) <= 256 && element.children.length === 0 &&
        ["div", "span", "p", "strong", "h1", "h2", "h3", "h4", "h5", "h6"].includes(element.tagName.toLowerCase()),
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
    if (command.kind === "installNativeProject") {
      const { project, priorEngine } = prepareBakedNativeProject(command.project, command.bakedTracks);
      if (originalEngine === undefined) originalEngine = priorEngine;
      let runtime: NativeProjectRuntime;
      try {
        runtime = installNativeProjectRuntime({
          window: view as Window & { __studioNativePlayer?: NativeProjectRuntime["player"] },
          document, project, activeSourceFile: command.activeSourceFile,
          clock: {
            now: () => view.performance.now(),
            requestAnimationFrame: callback => view.requestAnimationFrame(callback),
            cancelAnimationFrame: handle => view.cancelAnimationFrame(handle),
          },
          getPlaybackRate: () => nativePlaybackRate,
          useBaseAdapter: false,
        });
        runtime.player.seek(command.timeSeconds);
        if (command.playing) runtime.player.play();
      } catch (error) {
        restorePreviewEngine(priorEngine);
        throw error;
      }
      nativeRuntime?.cleanup();
      nativeRuntime = runtime;
      return null;
    }
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
    if (command.kind === "previewAudioGroup") {
      const groups = [...document.querySelectorAll("hf-audio-group[id]")]
        .filter(group => group.id === command.groupId);
      if (groups.length !== 1) throw new Error("unsupported-action");
      if (command.attribute === "data-fx-chain" && command.value !== null) {
        try { parseAudioFxChain(command.value); } catch { throw new Error("unsupported-action"); }
      }
      if (command.attribute === "data-automation" && command.value !== null) {
        try { parseAutomation(command.value); } catch { throw new Error("unsupported-action"); }
      }
      if (command.value === null) groups[0]!.removeAttribute(command.attribute);
      else groups[0]!.setAttribute(command.attribute, command.value);
      return null;
    }
    if (command.kind === "scrubAudio") {
      if (command.timeSeconds === null) { stopScrub(); return null; }
      const matches = [...document.querySelectorAll("audio[id]")]
        .filter(element => element.id === command.audioId);
      if (matches.length !== 1 || !(matches[0] instanceof HTMLAudioElement)) {
        throw new Error("unsupported-action");
      }
      const audio = matches[0];
      if (scrubAudio !== audio) {
        stopScrub();
        scrubAudio = audio;
        scrubMuted = audio.muted;
        scrubVolume = audio.volume;
      }
      audio.muted = false;
      audio.volume = Math.min(1, 0.25 * command.volume);
      if (Math.abs(audio.currentTime - command.timeSeconds) > 0.04) audio.currentTime = command.timeSeconds;
      if (audio.paused) void audio.play().catch(() => {});
      if (scrubTimer) clearTimeout(scrubTimer);
      scrubTimer = setTimeout(stopScrub, 140);
      return null;
    }
    const element = resolve(command.handle);
    if (!element) throw new Error("stale-handle");
    if (command.kind === "readElement") return describe(element);
    if (command.kind === "readGsap") {
      const file = sourceFile(element);
      return readPreviewGsapObservation({
        view, element, handle: command.handle, sourceFile: file,
        compositionPath: file, requestedChannels: command.channels,
        compositionId: command.compositionId,
      });
    }
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
      throw new Error("unsupported-action");
    }
    if (command.kind === "setStyle") {
      if ((command.property === "clip-path" && command.value !== "" && command.value !== "none" && !SIMPLE_CROP_PATH.test(command.value)) ||
          (command.property !== "clip-path" && !STYLE_PROPERTIES.has(command.property)) ||
          /url\s*\(|expression\s*\(|@import|[\u0000-\u001f]/i.test(command.value)) {
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
  } | PreviewTransportKeyEvent): void => view.parent.postMessage(message, options.parentOrigin);
  const transportKeys = new Set<string>(PREVIEW_TRANSPORT_KEYS);
  const onKey = (event: KeyboardEvent): void => {
    if (!token || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = event.target;
    if (target instanceof Element && (target.closest("input, textarea, select, [contenteditable]") ||
      (target as HTMLElement).isContentEditable)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (!transportKeys.has(key)) return;
    if (event.type === "keydown") event.preventDefault();
    send({ channel: PREVIEW_AGENT_CHANNEL, version: PREVIEW_AGENT_VERSION,
      type: "transport-key", token, phase: event.type === "keydown" ? "down" : "up",
      key: key as PreviewTransportKeyEvent["key"], shiftKey: event.shiftKey, repeat: event.repeat });
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== view.parent || event.origin !== options.parentOrigin) return;
    const control = event.data;
    if (control && typeof control === "object" && control.source === "hf-parent" &&
        control.type === "control" && nativeRuntime) {
      if (control.action === "play") nativeRuntime.player.play();
      else if (control.action === "pause") nativeRuntime.player.pause();
      else if (control.action === "seek" && typeof control.timeSeconds === "number" &&
          Number.isFinite(control.timeSeconds) && control.timeSeconds >= 0 && control.timeSeconds <= 86400) {
        nativeRuntime.player.seek(control.timeSeconds, { keepPlaying: nativeRuntime.player.isPlaying() });
      } else if (control.action === "set-playback-rate" && typeof control.rate === "number" &&
          Number.isFinite(control.rate) && control.rate > 0 && control.rate <= 8) {
        nativePlaybackRate = control.rate;
      }
      return;
    }
    if (isPreviewAgentInit(event.data)) {
      stopScrub();
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
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);
  return () => {
    stopScrub();
    view.removeEventListener("message", onMessage);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKey, true);
    nativeRuntime?.cleanup();
    nativeRuntime = null;
    if (originalEngine !== undefined) restorePreviewEngine(originalEngine);
    elements.clear();
    token = null;
  };
}
