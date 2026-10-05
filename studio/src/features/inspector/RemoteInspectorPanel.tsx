import { useEffect, useState } from "react";
import type { PreviewElementState, PreviewGsapChannel } from "../../../shared/preview/agentProtocol";
import type { PatchOperation } from "../legacy/sourcePatcher";
import type { RemoteGsapTarget } from "../animation/GSAP/remoteGsapSourceTransaction";

interface RemoteInspectorPanelProps {
  selection: PreviewElementState;
  commit?: (selection: PreviewElementState, operations: PatchOperation[] | "reset-design", label: string) => Promise<boolean>;
  loadGsap?: (selection: PreviewElementState) => Promise<RemoteGsapTarget[]>;
  commitGsap?: (selection: PreviewElementState, edit: {
    animationId: string; property: PreviewGsapChannel; value: number;
  }) => Promise<boolean>;
}

const TEXT_TAGS = new Set(["p", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6", "label", "figcaption"]);

/** The isolated frame contributes observations only; source transactions own every write. */
export function RemoteInspectorPanel({ selection, commit, loadGsap, commitGsap }: RemoteInspectorPanelProps) {
  const [text, setText] = useState(selection.text);
  const [color, setColor] = useState(selection.inlineStyles.color ?? "");
  const [backgroundColor, setBackgroundColor] = useState(selection.inlineStyles["background-color"] ?? "");
  const [fontSize, setFontSize] = useState(selection.inlineStyles["font-size"] ?? "");
  const [fontWeight, setFontWeight] = useState(selection.inlineStyles["font-weight"] ?? "");
  const [textAlign, setTextAlign] = useState(selection.inlineStyles["text-align"] ?? "");
  const [borderRadius, setBorderRadius] = useState(selection.inlineStyles["border-radius"] ?? "");
  const [opacity, setOpacity] = useState(selection.inlineStyles.opacity ?? "");
  const [busy, setBusy] = useState(false);
  const [gsapTargets, setGsapTargets] = useState<RemoteGsapTarget[]>([]);
  const [gsapTargetId, setGsapTargetId] = useState("");
  const [gsapProperty, setGsapProperty] = useState<PreviewGsapChannel | "">("");
  const [gsapValue, setGsapValue] = useState("");
  const [gsapBusy, setGsapBusy] = useState(false);
  useEffect(() => {
    setText(selection.text);
    setColor(selection.inlineStyles.color ?? "");
    setBackgroundColor(selection.inlineStyles["background-color"] ?? "");
    setFontSize(selection.inlineStyles["font-size"] ?? "");
    setFontWeight(selection.inlineStyles["font-weight"] ?? "");
    setTextAlign(selection.inlineStyles["text-align"] ?? "");
    setBorderRadius(selection.inlineStyles["border-radius"] ?? "");
    setOpacity(selection.inlineStyles.opacity ?? "");
    setGsapTargets([]);
    setGsapTargetId("");
    setGsapProperty("");
    setGsapValue("");
  }, [selection]);
  const selectGsapTarget = (id: string, targets = gsapTargets) => {
    const target = targets.find(item => item.id === id);
    const property = Object.keys(target?.properties ?? {})[0] as PreviewGsapChannel | undefined;
    setGsapTargetId(id);
    setGsapProperty(property ?? "");
    setGsapValue(property === undefined ? "" : String(target?.properties[property] ?? ""));
  };
  const selectGsapProperty = (property: PreviewGsapChannel) => {
    const target = gsapTargets.find(item => item.id === gsapTargetId);
    setGsapProperty(property);
    setGsapValue(String(target?.properties[property] ?? ""));
  };
  const loadAuthoredGsap = async () => {
    if (!loadGsap) return;
    setGsapBusy(true);
    try {
      const targets = await loadGsap(selection);
      setGsapTargets(targets);
      selectGsapTarget(targets[0]?.id ?? "", targets);
    } finally { setGsapBusy(false); }
  };
  const saveAuthoredGsap = async () => {
    if (!commitGsap || !gsapTargetId || !gsapProperty || !gsapValue.trim()) return;
    const value = Number(gsapValue);
    if (!Number.isFinite(value)) return;
    setGsapBusy(true);
    try { await commitGsap(selection, { animationId: gsapTargetId, property: gsapProperty, value }); }
    finally { setGsapBusy(false); }
  };
  // The agent marks a node editable only when its full text fits the snapshot.
  const textEditable = selection.textEditable && TEXT_TAGS.has(selection.tag);
  const save = async () => {
    if (!commit) return;
    const operations: PatchOperation[] = [];
    if (textEditable && text !== selection.text) {
      operations.push({ type: "text-content", property: "textContent", value: text.slice(0, 4096) });
    }
    if (color !== (selection.inlineStyles.color ?? "")) {
      if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) return;
      operations.push({ type: "inline-style", property: "color", value: color || null });
    }
    if (backgroundColor !== (selection.inlineStyles["background-color"] ?? "")) {
      if (backgroundColor && !/^#[0-9a-f]{3,8}$/i.test(backgroundColor)) return;
      operations.push({ type: "inline-style", property: "background-color", value: backgroundColor || null });
    }
    if (fontSize !== (selection.inlineStyles["font-size"] ?? "")) {
      if (fontSize && !/^(?:[1-9]\d?|[1-4]\d\d|500)px$/.test(fontSize)) return;
      operations.push({ type: "inline-style", property: "font-size", value: fontSize || null });
    }
    if (fontWeight !== (selection.inlineStyles["font-weight"] ?? "")) {
      if (fontWeight && !/^(?:normal|bold|[1-9]00)$/.test(fontWeight)) return;
      operations.push({ type: "inline-style", property: "font-weight", value: fontWeight || null });
    }
    if (textAlign !== (selection.inlineStyles["text-align"] ?? "")) {
      if (textAlign && !/^(?:left|right|center|justify|start|end)$/.test(textAlign)) return;
      operations.push({ type: "inline-style", property: "text-align", value: textAlign || null });
    }
    if (borderRadius !== (selection.inlineStyles["border-radius"] ?? "")) {
      if (borderRadius && !/^(?:0|(?:\d{1,3}|1000)px)$/.test(borderRadius)) return;
      operations.push({ type: "inline-style", property: "border-radius", value: borderRadius || null });
    }
    if (opacity !== (selection.inlineStyles.opacity ?? "")) {
      const number = Number(opacity);
      if (opacity && (!Number.isFinite(number) || number < 0 || number > 1)) return;
      operations.push({ type: "inline-style", property: "opacity", value: opacity || null });
    }
    if (operations.length === 0) return;
    setBusy(true);
    try { await commit(selection, operations, "Edit layer design"); }
    finally { setBusy(false); }
  };
  return <div className="h-full overflow-y-auto px-4 py-4 text-sm text-neutral-200" data-testid="remote-inspector">
    <div className="mb-4">
      <h2 className="font-semibold">{selection.id ? `#${selection.id}` : selection.tag}</h2>
      <p className="text-xs text-neutral-500">{selection.sourceFile}</p>
    </div>
    {commit && <>
    {textEditable && <label className="mb-3 block text-xs">Text
      <textarea aria-label="Text" maxLength={4096} value={text} onChange={event => setText(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>}
    <label className="mb-3 block text-xs">Color
      <input aria-label="Color" placeholder="#ffffff" maxLength={9} value={color} onChange={event => setColor(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>
    <label className="mb-3 block text-xs">Background color
      <input aria-label="Background color" placeholder="#000000" maxLength={9} value={backgroundColor}
        onChange={event => setBackgroundColor(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>
    <label className="mb-3 block text-xs">Font size
      <input aria-label="Font size" placeholder="16px" maxLength={5} value={fontSize} onChange={event => setFontSize(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>
    <label className="mb-3 block text-xs">Font weight
      <select aria-label="Font weight" value={fontWeight} onChange={event => setFontWeight(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100">
        {["", "normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map(value =>
          <option key={value} value={value}>{value || "Source default"}</option>)}
      </select>
    </label>
    <label className="mb-3 block text-xs">Text alignment
      <select aria-label="Text alignment" value={textAlign} onChange={event => setTextAlign(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100">
        {["", "left", "center", "right", "justify", "start", "end"].map(value =>
          <option key={value} value={value}>{value || "Source default"}</option>)}
      </select>
    </label>
    <label className="mb-3 block text-xs">Border radius
      <input aria-label="Border radius" placeholder="0px" maxLength={6} value={borderRadius}
        onChange={event => setBorderRadius(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>
    <label className="mb-3 block text-xs">Opacity
      <input aria-label="Opacity" placeholder="1" maxLength={8} value={opacity} onChange={event => setOpacity(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-100" />
    </label>
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => void save()}
        className="rounded bg-blue-600 px-3 py-2 text-xs font-medium disabled:opacity-50">Save design</button>
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        void commit(selection, "reset-design", "Reset design").finally(() => setBusy(false));
      }} className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Reset design</button>
    </div>
    </>}
    {loadGsap && commitGsap && <section className="mt-5 border-t border-neutral-700 pt-4" aria-label="Authored animations">
      <h3 className="mb-2 font-medium">Authored animations</h3>
      <button type="button" disabled={gsapBusy} onClick={() => void loadAuthoredGsap()}
        className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Load animations</button>
      {gsapTargets.length === 0 && <p className="mt-2 text-xs text-neutral-500">Only simple source-bound animations can be edited here.</p>}
      {gsapTargets.length > 0 && <div className="mt-3 space-y-3">
        <label className="block text-xs">Animation
          <select aria-label="Animation" value={gsapTargetId} onChange={event => selectGsapTarget(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
            {gsapTargets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
          </select>
        </label>
        <label className="block text-xs">Property
          <select aria-label="Animation property" value={gsapProperty}
            onChange={event => selectGsapProperty(event.target.value as PreviewGsapChannel)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
            {Object.keys(gsapTargets.find(target => target.id === gsapTargetId)?.properties ?? {}).map(property =>
              <option key={property} value={property}>{property}</option>)}
          </select>
        </label>
        <label className="block text-xs">Value
          <input aria-label="Animation value" type="number" step="any" value={gsapValue}
            onChange={event => setGsapValue(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
        </label>
        <button type="button" disabled={gsapBusy} onClick={() => void saveAuthoredGsap()}
          className="rounded bg-blue-600 px-3 py-2 text-xs font-medium disabled:opacity-50">Save animation</button>
      </div>}
    </section>}
  </div>;
}
