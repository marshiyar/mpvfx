export type InteractionRecorder = (event: string, data: Record<string, unknown>) => void;

function describeTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return { tag: "unknown" };
  const control = target.closest("button,input,select,textarea,[role],[data-diagnostic-action]") ?? target;
  const rawAction = control.getAttribute("data-diagnostic-action") ?? "";
  const tab = control.getAttribute("data-tab-id");
  const ancestry: string[] = [];
  let node: Element | null = control;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    ancestry.push(`${node.tagName.toLowerCase()}:${node.parentElement ? Array.prototype.indexOf.call(node.parentElement.children, node) : 0}`);
  }
  return {
    tag: control.tagName.toLowerCase(),
    role: control.getAttribute("role"),
    action: /^[a-z][a-z0-9-]{1,60}$/.test(rawAction) ? rawAction : undefined,
    tab: tab && ["assets", "compositions", "blocks"].includes(tab) ? tab : undefined,
    // Structural location is useful even when a control has no action tag. Do
    // not read labels, text, arbitrary DOM ids, hrefs or editable values.
    ancestry, inputType: control instanceof HTMLInputElement ? control.type : undefined,
    disabled: control.hasAttribute("disabled"), selected: control.getAttribute("aria-selected") === "true",
  };
}

export function installInteractionCapture(win: Window, record: InteractionRecorder): () => void {
  const doc = win.document;
  const listeners: Array<[string, EventListener]> = [];
  const on = (event: string, listener: EventListener) => { doc.addEventListener(event, listener, true); listeners.push([event, listener]); };
  let pointer: { x: number; y: number; time: number } | null = null;
  on("click", (event) => {
    const e = event as MouseEvent;
    record("ui.click", { target: describeTarget(e.composedPath()[0] ?? e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, count: e.detail, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
  });
  on("change", (e) => record("ui.change", { target: describeTarget(e.target) }));
  on("pointerdown", (event) => {
    const e = event as PointerEvent;
    pointer = { x: e.clientX, y: e.clientY, time: performance.now() };
    record("ui.pointer_down", { target: describeTarget(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, pointerType: e.pointerType });
  });
  for (const eventName of ["pointerup", "pointercancel"]) on(eventName, (event) => {
    const e = event as PointerEvent;
    record(`ui.${eventName === "pointerup" ? "pointer_up" : "pointer_cancel"}`, { target: describeTarget(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), distance: pointer ? Math.round(Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y)) : null, durationMs: pointer ? Math.round(performance.now() - pointer.time) : null });
    pointer = null;
  });
  on("keydown", (event) => {
    const e = event as KeyboardEvent;
    const target = e.composedPath()[0] ?? e.target;
    if (e.repeat || (target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))) return;
    if (!(e.ctrlKey || e.metaKey || ["Escape", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key))) return;
    // Explicit navigation/edit shortcuts only; never typed text or clipboard.
    if (!/^[a-z0-9]$/i.test(e.key) && !["Escape", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) return;
    record("ui.shortcut", { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, target: describeTarget(target) });
  });
  return () => listeners.forEach(([event, listener]) => doc.removeEventListener(event, listener, true));
}
