import { useEffect, useState } from "react";
import type { PreviewElementState, PreviewGsapChannel } from "../../../shared/preview/agentProtocol";
import { PREVIEW_GSAP_CHANNELS } from "../../../shared/preview/agentProtocol";
import type { PatchOperation } from "../legacy/sourcePatcher";
import type { RemoteGsapTarget, commitRemoteGsapAnimationAction } from "../animation/GSAP/remoteGsapSourceTransaction";
import type { RemoteNativeMediaCommand, RemoteNativeMediaSnapshot } from "../project/remoteInspectorNativeMediaTransaction";
import { RemoteMediaInspectorSection } from "./RemoteMediaInspectorSection";
import { RemoteVisualInspectorSection } from "./RemoteVisualInspectorSection";
import { RemoteLegacyGradeSection } from "./RemoteLegacyGradeSection";

interface RemoteInspectorPanelProps {
  selection: PreviewElementState;
  commit?: (selection: PreviewElementState, operations: PatchOperation[] | "reset-design", label: string) => Promise<boolean>;
  loadGsap?: (selection: PreviewElementState) => Promise<RemoteGsapTarget[]>;
  commitGsap?: (selection: PreviewElementState, edit: {
    animationId: string; property: PreviewGsapChannel; value: number; endpoint?: "from" | "to";
  }) => Promise<boolean>;
  commitGsapKeyframe?: (selection: PreviewElementState, edit: {
    animationId: string; action: "update" | "add" | "remove" | "ease"; percentage: number;
    property?: PreviewGsapChannel; value?: number; ease?: string;
  }) => Promise<boolean>;
  commitGsapAnimation?: (selection: PreviewElementState,
    action: Parameters<typeof commitRemoteGsapAnimationAction>[2]) => Promise<boolean>;
  nativeMedia?: RemoteNativeMediaSnapshot | null;
  commitMedia?: (selection: PreviewElementState, command: RemoteNativeMediaCommand) => Promise<boolean>;
  commitLegacyGrade?: (selection: PreviewElementState, presetId: string | null) => Promise<boolean>;
}

const TEXT_TAGS = new Set(["p", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6", "label", "figcaption"]);
const GSAP_EASES = ["none", ...["power1", "power2", "power3", "power4", "sine", "expo", "circ"]
  .flatMap(family => ["in", "out", "inOut"].map(direction => `${family}.${direction}`))];

/** The isolated frame contributes observations only; source transactions own every write. */
export function RemoteInspectorPanel({ selection, commit, loadGsap, commitGsap,
  commitGsapKeyframe, commitGsapAnimation, nativeMedia, commitMedia,
  commitLegacyGrade }: RemoteInspectorPanelProps) {
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
  const [gsapFromValue, setGsapFromValue] = useState("");
  const [gsapEase, setGsapEase] = useState("");
  const [motionPointIndex, setMotionPointIndex] = useState(0);
  const [motionPointX, setMotionPointX] = useState("");
  const [motionPointY, setMotionPointY] = useState("");
  const [gsapKeyframePercentage, setGsapKeyframePercentage] = useState("");
  const [gsapKeyframeValue, setGsapKeyframeValue] = useState("");
  const [gsapKeyframeEase, setGsapKeyframeEase] = useState("");
  const [gsapBusy, setGsapBusy] = useState(false);
  const [newGsapMethod, setNewGsapMethod] = useState<"to" | "from" | "fromTo" | "set">("to");
  const [newGsapProperty, setNewGsapProperty] = useState<PreviewGsapChannel>("x");
  const [newGsapValue, setNewGsapValue] = useState("");
  const [newGsapFromValue, setNewGsapFromValue] = useState("");
  const [newGsapEase, setNewGsapEase] = useState("");
  const [newGsapPosition, setNewGsapPosition] = useState("0");
  const [newGsapDuration, setNewGsapDuration] = useState("1");
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
    setGsapFromValue("");
    setGsapEase("");
    setMotionPointIndex(0);
    setMotionPointX("");
    setMotionPointY("");
    setGsapKeyframePercentage("");
    setGsapKeyframeValue("");
    setGsapKeyframeEase("");
  }, [selection]);
  const selectGsapTarget = (id: string, targets = gsapTargets) => {
    const target = targets.find(item => item.id === id);
    const property = Object.keys(target?.properties ?? {})[0] as PreviewGsapChannel | undefined;
    setGsapTargetId(id);
    setGsapProperty(property ?? "");
    const firstFrame = target?.keyframes?.[0];
    setGsapKeyframePercentage(firstFrame ? String(firstFrame.percentage) : "");
    setGsapValue(property === undefined ? "" : String(target?.properties[property] ?? ""));
    setGsapFromValue(property === undefined ? "" : String(target?.fromProperties?.[property] ?? ""));
    setGsapEase(target?.ease ?? "");
    setMotionPointIndex(0);
    setMotionPointX(String(target?.motionPath?.points[0]?.x ?? ""));
    setMotionPointY(String(target?.motionPath?.points[0]?.y ?? ""));
    setGsapKeyframeValue(property === undefined ? "" : String(firstFrame?.properties[property] ?? ""));
    setGsapKeyframeEase(firstFrame?.ease ?? "");
  };
  const selectGsapProperty = (property: PreviewGsapChannel) => {
    const target = gsapTargets.find(item => item.id === gsapTargetId);
    setGsapProperty(property);
    const frame = target?.keyframes?.find(item => String(item.percentage) === gsapKeyframePercentage);
    setGsapValue(String(target?.properties[property] ?? ""));
    setGsapFromValue(String(target?.fromProperties?.[property] ?? ""));
    setGsapKeyframeValue(String(frame?.properties[property] ?? ""));
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
  const saveAuthoredGsap = async (endpoint: "from" | "to" = "to") => {
    const input = endpoint === "from" ? gsapFromValue : gsapValue;
    if (!commitGsap || !gsapTargetId || !gsapProperty || !input.trim()) return;
    const value = Number(input);
    if (!Number.isFinite(value)) return;
    setGsapBusy(true);
    try { await commitGsap(selection, { animationId: gsapTargetId, property: gsapProperty, value,
      ...(endpoint === "from" ? { endpoint } : {}) }); }
    finally { setGsapBusy(false); }
  };
  const saveAuthoredKeyframe = async (action: "update" | "add" | "remove" | "ease") => {
    if (!commitGsapKeyframe || !gsapTargetId || !gsapKeyframePercentage.trim()) return;
    const percentage = Number(gsapKeyframePercentage);
    const value = Number(gsapKeyframeValue);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 ||
        (action === "ease" && !GSAP_EASES.includes(gsapKeyframeEase)) ||
        (action !== "remove" && action !== "ease" &&
          (!gsapProperty || !gsapKeyframeValue.trim() || !Number.isFinite(value)))) return;
    setGsapBusy(true);
    try { await commitGsapKeyframe(selection, {
      animationId: gsapTargetId, action, percentage,
      ...(action === "ease" ? { ease: gsapKeyframeEase } :
        action === "remove" ? {} : { property: gsapProperty as PreviewGsapChannel, value }),
    }); }
    finally { setGsapBusy(false); }
  };
  const changeAnimation = async (action: "add" | "remove" | "ease" | "motion-point" |
    "add-motion-point" | "remove-motion-point") => {
    if (!commitGsapAnimation || (action !== "add" && !gsapTargetId)) return;
    const value = Number(newGsapValue);
    const position = Number(newGsapPosition);
    const duration = Number(newGsapDuration);
    if (action === "add" && (!newGsapValue.trim() || !Number.isFinite(value) ||
      !newGsapPosition.trim() || !Number.isFinite(position) || position < 0 ||
      (newGsapMethod !== "set" && (!newGsapDuration.trim() || !Number.isFinite(duration) || duration <= 0)) ||
      (newGsapMethod === "fromTo" && (!newGsapFromValue.trim() || !Number.isFinite(Number(newGsapFromValue)))))) return;
    if (action === "ease" && !GSAP_EASES.includes(gsapEase)) return;
    if ((action === "motion-point" || action === "add-motion-point") &&
        (!motionPointX.trim() || !motionPointY.trim() ||
        !Number.isFinite(Number(motionPointX)) || !Number.isFinite(Number(motionPointY)))) return;
    setGsapBusy(true);
    try {
      const saved = await commitGsapAnimation(selection, action === "remove"
        ? { action: "remove", animationId: gsapTargetId }
        : action === "ease" ? { action: "ease", animationId: gsapTargetId, ease: gsapEase }
        : action === "motion-point" ? { action: "motion-point", animationId: gsapTargetId,
            index: motionPointIndex, x: Number(motionPointX), y: Number(motionPointY) }
        : action === "add-motion-point" ? { action: "add-motion-point", animationId: gsapTargetId,
            index: motionPointIndex, x: Number(motionPointX), y: Number(motionPointY) }
        : action === "remove-motion-point" ? { action: "remove-motion-point", animationId: gsapTargetId,
            index: motionPointIndex }
        : { action: "add", method: newGsapMethod, property: newGsapProperty, value,
          position, ...(newGsapMethod !== "set" ? { duration } : {}),
          ...(newGsapMethod === "fromTo" ? { fromValue: Number(newGsapFromValue) } : {}),
          ...(newGsapEase ? { ease: newGsapEase } : {}) });
      if (saved && loadGsap) {
        const targets = await loadGsap(selection);
        setGsapTargets(targets);
        selectGsapTarget(targets[0]?.id ?? "", targets);
      }
    } finally { setGsapBusy(false); }
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
    {commit && <RemoteVisualInspectorSection selection={selection} commit={commit} />}
    {commitLegacyGrade && <RemoteLegacyGradeSection key={selection.handle} selection={selection} commit={commitLegacyGrade} />}
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
        {!gsapTargets.find(target => target.id === gsapTargetId)?.motionPath && <>
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
        </>}
        {gsapTargets.find(target => target.id === gsapTargetId)?.motionPath && <div className="space-y-2 border-t border-neutral-700 pt-3">
          <p className="text-xs font-medium">Motion path points</p>
          <label className="block text-xs">Point
            <select aria-label="Motion path point" value={motionPointIndex}
              onChange={event => {
                const index = Number(event.target.value);
                const point = gsapTargets.find(target => target.id === gsapTargetId)?.motionPath?.points[index];
                setMotionPointIndex(index);
                setMotionPointX(String(point?.x ?? ""));
                setMotionPointY(String(point?.y ?? ""));
              }} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
              {gsapTargets.find(target => target.id === gsapTargetId)?.motionPath?.points.map((_, index) =>
                <option key={index} value={index}>{index + 1}</option>)}
            </select>
          </label>
          <label className="block text-xs">Point X
            <input aria-label="Motion path point X" type="number" step="any" value={motionPointX}
              onChange={event => setMotionPointX(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
          </label>
          <label className="block text-xs">Point Y
            <input aria-label="Motion path point Y" type="number" step="any" value={motionPointY}
              onChange={event => setMotionPointY(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
          </label>
          <button type="button" disabled={gsapBusy} onClick={() => void changeAnimation("motion-point")}
            className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save motion point</button>
          <div className="flex gap-2">
            <button type="button" disabled={gsapBusy || motionPointIndex < 1 ||
                (gsapTargets.find(target => target.id === gsapTargetId)?.motionPath?.points.length ?? 0) >= 64}
              onClick={() => void changeAnimation("add-motion-point")}
              className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">
              Insert point before selected
            </button>
            <button type="button" disabled={gsapBusy || motionPointIndex < 1 ||
                motionPointIndex >= (gsapTargets.find(target => target.id === gsapTargetId)
                  ?.motionPath?.points.length ?? 0) - 1}
              onClick={() => void changeAnimation("remove-motion-point")}
              className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">
              Remove selected point
            </button>
          </div>
        </div>}
        {gsapTargets.find(target => target.id === gsapTargetId)?.method === "fromTo" &&
          gsapTargets.find(target => target.id === gsapTargetId)?.fromProperties?.[gsapProperty as PreviewGsapChannel] !== undefined && <>
          <label className="block text-xs">From value
            <input aria-label="Animation from value" type="number" step="any" value={gsapFromValue}
              onChange={event => setGsapFromValue(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
          </label>
          <button type="button" disabled={gsapBusy} onClick={() => void saveAuthoredGsap("from")}
            className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save from value</button>
        </>}
        {commitGsapAnimation && gsapTargets.find(target => target.id === gsapTargetId)?.method !== "set" &&
          !gsapTargets.find(target => target.id === gsapTargetId)?.keyframes && <div className="space-y-2">
          <label className="block text-xs">Easing
            <select aria-label="Animation easing" value={gsapEase}
              onChange={event => setGsapEase(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
              <option value="">GSAP default</option>
              {gsapEase && !GSAP_EASES.includes(gsapEase) && <option value={gsapEase}>{gsapEase} (source)</option>}
              {GSAP_EASES.map(ease => <option key={ease} value={ease}>{ease}</option>)}
            </select>
          </label>
          <button type="button" disabled={gsapBusy || !GSAP_EASES.includes(gsapEase)}
            onClick={() => void changeAnimation("ease")}
            className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save easing</button>
        </div>}
        {commitGsapAnimation && <button type="button" disabled={gsapBusy}
          onClick={() => void changeAnimation("remove")}
          className="ml-2 rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Remove animation</button>}
        {commitGsapKeyframe && gsapTargets.find(target => target.id === gsapTargetId)?.keyframes &&
          <div className="space-y-2 border-t border-neutral-700 pt-3">
            <label className="block text-xs">Keyframe position (%)
              <input aria-label="Keyframe position" type="number" min="0" max="100" step="any"
                value={gsapKeyframePercentage} onChange={event => {
                  const percentage = event.target.value;
                  setGsapKeyframePercentage(percentage);
                  const frame = gsapTargets.find(target => target.id === gsapTargetId)?.keyframes
                    ?.find(item => String(item.percentage) === percentage);
                  if (frame && gsapProperty) setGsapKeyframeValue(String(frame.properties[gsapProperty] ?? ""));
                  setGsapKeyframeEase(frame?.ease ?? "");
                }} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
            </label>
            <label className="block text-xs">Keyframe value
              <input aria-label="Keyframe value" type="number" step="any" value={gsapKeyframeValue}
                onChange={event => setGsapKeyframeValue(event.target.value)}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
            </label>
            <label className="block text-xs">Keyframe easing
              <select aria-label="Keyframe easing" value={gsapKeyframeEase}
                onChange={event => setGsapKeyframeEase(event.target.value)}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
                <option value="">Choose easing</option>
                {GSAP_EASES.map(ease => <option key={ease} value={ease}>{ease}</option>)}
              </select>
            </label>
            <p className="text-xs text-neutral-500">Authored: {gsapTargets.find(target => target.id === gsapTargetId)
              ?.keyframes?.map(frame => `${frame.percentage}%`).join(", ")}</p>
            <div className="flex flex-wrap gap-2">
              {(["update", "add", "remove", "ease"] as const).map(action => <button key={action} type="button"
                disabled={gsapBusy || action === "ease" && !GSAP_EASES.includes(gsapKeyframeEase)}
                onClick={() => void saveAuthoredKeyframe(action)}
                className="rounded border border-neutral-700 px-2 py-1 text-xs disabled:opacity-50">
                {action === "update" ? "Save keyframe" : action === "add" ? "Add keyframe" :
                  action === "remove" ? "Remove keyframe" : "Save keyframe easing"}
              </button>)}
            </div>
          </div>}
      </div>}
      {commitGsapAnimation && <div className="mt-4 space-y-2 border-t border-neutral-700 pt-3">
        <p className="text-xs font-medium">Add simple animation</p>
        <label className="block text-xs">Method
          <select aria-label="New animation method" value={newGsapMethod}
            onChange={event => setNewGsapMethod(event.target.value as "to" | "from" | "fromTo" | "set")}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
            <option value="to">To</option><option value="from">From</option>
            <option value="fromTo">From → To</option><option value="set">Set</option>
          </select>
        </label>
        <label className="block text-xs">Property
          <select aria-label="New animation property" value={newGsapProperty}
            onChange={event => setNewGsapProperty(event.target.value as PreviewGsapChannel)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
            {PREVIEW_GSAP_CHANNELS.map(property =>
              <option key={property} value={property}>{property}</option>)}
          </select>
        </label>
        {newGsapMethod === "fromTo" && <label className="block text-xs">From value
          <input aria-label="New animation from value" type="number" step="any" value={newGsapFromValue}
            onChange={event => setNewGsapFromValue(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
        </label>}
        <label className="block text-xs">Value
          <input aria-label="New animation value" type="number" step="any" value={newGsapValue}
            onChange={event => setNewGsapValue(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
        </label>
        <label className="block text-xs">Position (seconds)
          <input aria-label="New animation position" type="number" min="0" step="any" value={newGsapPosition}
            onChange={event => setNewGsapPosition(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
        </label>
        {newGsapMethod !== "set" && <label className="block text-xs">Duration (seconds)
          <input aria-label="New animation duration" type="number" min="0.001" step="any" value={newGsapDuration}
            onChange={event => setNewGsapDuration(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
        </label>}
        {newGsapMethod !== "set" && <label className="block text-xs">Easing
          <select aria-label="New animation easing" value={newGsapEase}
            onChange={event => setNewGsapEase(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
            <option value="">GSAP default</option>
            {GSAP_EASES.map(ease => <option key={ease} value={ease}>{ease}</option>)}
          </select>
        </label>}
        <button type="button" disabled={gsapBusy} onClick={() => void changeAnimation("add")}
          className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Add animation</button>
      </div>}
    </section>}
    {nativeMedia && commitMedia && <RemoteMediaInspectorSection selection={selection}
      media={nativeMedia} commit={commitMedia} />}
  </div>;
}
