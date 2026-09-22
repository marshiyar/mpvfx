import { parseGsapScriptAcornForWrite } from "@hyperframes/parsers/gsap-parser-acorn";
import { ancestor } from "acorn-walk";
import { parse } from "acorn";
import type { PatchTarget } from "./sourcePatcher";

interface AnimationCopy {
  scriptIndex: number;
  timeline: string;
  global: boolean;
  method: string;
  selector: string;
  targets: { clip: number; node: number }[];
  args: string[];
  position: number;
}
export interface AuthoredClipSnapshot {
  readonly html: readonly string[];
  readonly starts: readonly number[];
  readonly styles: readonly string[];
  readonly animations: readonly AnimationCopy[];
  readonly parents: readonly (PatchTarget | null)[];
  readonly origins: readonly PatchTarget[];
}
const parseHtml = (source: string) => new DOMParser().parseFromString(source, "text/html");
const serializeHtml = (doc: Document, original: string) =>
  /^\s*<!doctype/i.test(original)
    ? `<!doctype html>\n${doc.documentElement.outerHTML}`
    : /<html[\s>]/i.test(original)
      ? doc.documentElement.outerHTML
      : doc.body.innerHTML;
function remapSelector(selector: string, ids: ReadonlyMap<string, string>): string {
  return selector.replace(/#([a-zA-Z_][\w-]*)/g, (match, id: string) =>
    ids.has(id) ? `#${ids.get(id)}` : match,
  );
}
function find(doc: Document, target: PatchTarget): Element {
  let matches: Element[] = [];
  if (target.hfId)
    matches = [...doc.querySelectorAll("[data-hf-id]")].filter(
      (el) => el.getAttribute("data-hf-id") === target.hfId,
    );
  else if (target.id)
    matches = [...doc.querySelectorAll("[id]")].filter((el) => el.id === target.id);
  else if (target.selector) {
    matches = [...doc.querySelectorAll(target.selector)];
    if (target.selectorIndex !== undefined)
      matches = matches.slice(target.selectorIndex, target.selectorIndex + 1);
  }
  if (matches.length !== 1)
    throw new Error("Copy requires one unambiguous authored element per selection.");
  return matches[0]!;
}
function isStatic(node: Record<string, unknown> | undefined): boolean {
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type === "UnaryExpression")
    return (
      ["-", "+", "!"].includes(String(node.operator)) &&
      isStatic(node.argument as Record<string, unknown>)
    );
  if (node.type === "ArrayExpression")
    return (node.elements as Record<string, unknown>[]).every(isStatic);
  if (node.type === "ObjectExpression")
    return (node.properties as Record<string, unknown>[]).every(
      (p) =>
        p.type === "Property" &&
        !p.computed &&
        p.kind === "init" &&
        !p.method &&
        isStatic(p.value as Record<string, unknown>),
    );
  return false;
}

/** Capture disk-authored content, never the live preview's animated inline styles. */
export function captureAuthoredClips(
  source: string,
  targets: readonly PatchTarget[],
): AuthoredClipSnapshot {
  if (!targets.length) throw new Error("Select clips to copy.");
  const doc = parseHtml(source);
  const elements = targets.map((target) => find(doc, target));
  for (const element of elements) {
    if (
      !element.parentElement ||
      element.matches("html,head,body") ||
      (element.hasAttribute("data-composition-id") &&
        !element.closest("[data-composition-id] [data-composition-id]"))
    ) {
      throw new Error("The composition root cannot be copied as a clip.");
    }
    if (
      elements.some((other) => other !== element && other.contains(element)) ||
      elements.filter((other) => other === element).length > 1
    ) {
      throw new Error("Copy the group or its children, not both in one selection.");
    }
  }
  const nodeLists = elements.map((el) => [el, ...el.querySelectorAll("*")]);
  const root = doc.querySelector("[data-composition-id]");
  const parents = elements.map((element) => {
    const parent = element.parentElement!;
    if (parent === root) return null;
    if (!parent.id && !parent.hasAttribute("data-hf-id"))
      throw new Error("This group needs a stable identity before its clips can be copied safely.");
    return {
      id: parent.id || undefined,
      hfId: parent.getAttribute("data-hf-id") ?? undefined,
    };
  });
  const selectedNodes = new Set(nodeLists.flat());
  const animations: AnimationCopy[] = [];
  [...doc.querySelectorAll("script")].forEach((script, scriptIndex) => {
    const text = script.textContent ?? "";
    const parsed = parseGsapScriptAcornForWrite(text);
    if (!parsed) return;
    for (const { call, animation } of parsed.located) {
      let resolved: Element[];
      try {
        resolved = [...doc.querySelectorAll(call.selector)];
      } catch {
        throw new Error("This animation uses a selector that cannot be copied safely.");
      }
      if (!resolved.some((node) => selectedNodes.has(node))) continue;
      if (resolved.some((node) => !selectedNodes.has(node))) {
        throw new Error(
          "This animation targets selected and unselected elements. Separate its targets before copying.",
        );
      }
      const targets = resolved.map((node) => {
        const clip = nodeLists.findIndex((nodes) => nodes.includes(node));
        return { clip, node: nodeLists[clip]!.indexOf(node) };
      });
      const argumentsToCopy = [call.fromArg, call.varsArg].filter(Boolean);
      if (
        !argumentsToCopy.every(isStatic) ||
        (typeof animation.position !== "number" && animation.position !== undefined)
      ) {
        throw new Error(
          "This clip has dynamic animation expressions. Convert them to editable keyframes before copying.",
        );
      }
      animations.push({
        scriptIndex,
        timeline: parsed.timelineVar,
        global: call.global === true,
        method: call.method,
        selector: call.selector,
        targets,
        args: argumentsToCopy.map((node) => text.slice(node.start, node.end)),
        position: typeof animation.position === "number" ? animation.position : 0,
      });
    }
  });
  return {
    html: elements.map((el) => el.outerHTML),
    starts: elements.map((el) => Number(el.getAttribute("data-start") ?? 0)),
    styles: [...doc.querySelectorAll("style")].map((style) => style.textContent ?? ""),
    animations,
    parents,
    origins: targets.map((target) => ({ ...target })),
  };
}

function timelineScopeEnd(script: string, timeline: string): number {
  let end: number | undefined;
  const ast = parse(script, { ecmaVersion: "latest", sourceType: "script" });
  ancestor(ast, {
    VariableDeclarator(node, _state, parents) {
      if (node.id.type !== "Identifier" || node.id.name !== timeline) return;
      if (end !== undefined) throw new Error("The destination has ambiguous animation timelines.");
      const block = [...parents].reverse().find((parent) => parent.type === "BlockStatement");
      end = block ? block.end - 1 : script.length;
    },
  });
  if (end === undefined)
    throw new Error("The original animation timeline is no longer available for paste.");
  return end;
}

/** Same-composition paste; callers transact this result with the native sidecar. */
export function pasteAuthoredClips(
  source: string,
  snapshot: AuthoredClipSnapshot,
  start: number,
  nonce: string,
  identitySuffix = `copy-${nonce}`,
) {
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    snapshot.starts.some((time) => !Number.isFinite(time))
  )
    throw new Error("Invalid paste time.");
  const doc = parseHtml(source);
  const root = doc.querySelector("[data-composition-id]");
  if (!root) throw new Error("The destination composition is missing.");
  const originalCalls = [...doc.querySelectorAll("script")].map((script) => ({
    script,
    calls: (parseGsapScriptAcornForWrite(script.textContent ?? "")?.located ?? []).map(
      ({ call }) => ({
        call,
        nodes: [...doc.querySelectorAll(call.selector)],
      }),
    ),
  }));
  const delta = start - Math.min(...snapshot.starts);
  const used = new Set([...doc.querySelectorAll("[id]")].map((el) => el.id));
  const ids = new Map<string, string>();
  const unique = (base: string) => {
    const safe = base.replace(/[^a-zA-Z0-9_-]/g, "-");
    let id = `${safe}-${identitySuffix}`;
    let suffix = 2;
    while (used.has(id)) id = `${safe}-${identitySuffix}-${suffix++}`;
    used.add(id);
    return id;
  };
  const copies = snapshot.html.map((html, index) => {
    const element = parseHtml(html).body.firstElementChild!;
    for (const node of [element, ...element.querySelectorAll("*")]) {
      const oldId = node.id;
      if (oldId) {
        const id = unique(oldId);
        ids.set(oldId, id);
        node.id = id;
      }
      node.removeAttribute("data-studio-clip-id");
      node.removeAttribute("data-studio-native-owned");
      node.removeAttribute("data-hf-id");
      if (node.hasAttribute("data-composition-id"))
        node.setAttribute("data-composition-id", unique(node.getAttribute("data-composition-id")!));
    }
    if (!element.id) element.id = unique(`clip-${index}`);
    element.setAttribute("data-start", String(snapshot.starts[index]! + delta));
    // Stable IDs are written with the transaction, not added by a later preview load.
    for (const [i, node] of [element, ...element.querySelectorAll("*")].entries())
      node.setAttribute("data-hf-id", `${element.id}-node-${i}`);
    return element;
  });
  for (const [index, element] of copies.entries()) {
    for (const node of [element, ...element.querySelectorAll("*")]) {
      for (const attribute of [...node.attributes]) {
        if (["for", "aria-labelledby", "aria-describedby"].includes(attribute.name))
          node.setAttribute(
            attribute.name,
            attribute.value
              .split(/\s+/)
              .map((id) => ids.get(id) ?? id)
              .join(" "),
          );
        if (
          ["href", "xlink:href", "clip-path", "mask", "filter", "fill", "stroke", "style"].includes(
            attribute.name,
          )
        ) {
          const value = attribute.value.replace(/url\(#([^)]+)\)/g, (match, id: string) =>
            ids.has(id) ? `url(#${ids.get(id)})` : match,
          );
          node.setAttribute(
            attribute.name,
            value.startsWith("#") && ids.has(value.slice(1))
              ? `#${ids.get(value.slice(1))}`
              : value,
          );
        }
      }
    }
    const parent = snapshot.parents[index] ? find(doc, snapshot.parents[index]!) : root;
    let origin: Element | null = null;
    try {
      origin = find(doc, snapshot.origins[index]!);
    } catch {
      /* Cut clips no longer have an original sibling. */
    }
    if (origin?.parentElement === parent) origin.after(element);
    else parent.append(element);
  }
  // A class/tag selector must keep its old ownership when a matching instance
  // is pasted. Otherwise its original tween also starts animating the new clip.
  for (const { script, calls } of originalCalls) {
    let text = script.textContent ?? "";
    const edits = calls
      .filter(({ call, nodes }) => doc.querySelectorAll(call.selector).length !== nodes.length)
      .map(({ call, nodes }) => {
        const selector =
          nodes
            .map((node) => {
              if (!node.id) node.id = unique("animation-target");
              return `#${node.id}`;
            })
            .join(",") || ":not(*)";
        const argument = call.node.arguments[0];
        return {
          start: argument.start as number,
          end: argument.end as number,
          value: JSON.stringify(selector),
        };
      });
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    script.textContent = text;
  }
  const copyRules = (rules: CSSRuleList): string =>
    [...rules]
      .map((rule) => {
        if ("selectorText" in rule && "style" in rule) {
          const styleRule = rule as CSSStyleRule;
          const mapped = remapSelector(styleRule.selectorText, ids);
          return mapped === styleRule.selectorText ? "" : `${mapped}{${styleRule.style.cssText}}`;
        }
        if ("cssRules" in rule) {
          const body = copyRules((rule as CSSGroupingRule).cssRules);
          return body ? `${rule.cssText.slice(0, rule.cssText.indexOf("{"))}{${body}}` : "";
        }
        return "";
      })
      .join("\n");
  for (const css of snapshot.styles) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const remapped = copyRules(sheet.cssRules);
    if (remapped.trim()) {
      const style = doc.querySelector("style") ?? doc.head.appendChild(doc.createElement("style"));
      style.textContent += `\n${remapped}`;
    }
  }
  const scripts = [...doc.querySelectorAll("script")];
  const insertions = new Map<number, Map<number, string[]>>();
  for (const animation of snapshot.animations) {
    const script = scripts[animation.scriptIndex];
    if (!script || script.hasAttribute("src"))
      throw new Error("The original animation script is no longer available.");
    const text = script.textContent ?? "";
    const position = animation.position + delta;
    if (!animation.global && position < 0)
      throw new Error("Paste would move legacy animation before the composition starts.");
    const end = animation.global ? text.length : timelineScopeEnd(text, animation.timeline);
    const selector = animation.targets
      .map((target) => {
        const nodes = [copies[target.clip]!, ...copies[target.clip]!.querySelectorAll("*")];
        const node = nodes[target.node]!;
        return node.id ? `#${node.id}` : `[data-hf-id="${node.getAttribute("data-hf-id")}"]`;
      })
      .join(",");
    const code = `${animation.global ? "gsap" : animation.timeline}.${animation.method}(${JSON.stringify(selector)},${animation.args.join(",")}${animation.global ? "" : `,${position}`});`;
    const perScript = insertions.get(animation.scriptIndex) ?? new Map<number, string[]>();
    perScript.set(end, [...(perScript.get(end) ?? []), code]);
    insertions.set(animation.scriptIndex, perScript);
  }
  for (const [index, positions] of insertions) {
    let text = scripts[index]!.textContent ?? "";
    for (const [end, lines] of [...positions].sort(([a], [b]) => b - a))
      text = `${text.slice(0, end)}\n${lines.join("\n")}\n${text.slice(end)}`;
    scripts[index]!.textContent = text;
  }
  const end = Math.max(
    Number(root.getAttribute("data-duration") ?? 0),
    ...copies.map(
      (el) => Number(el.getAttribute("data-start")) + Number(el.getAttribute("data-duration") ?? 0),
    ),
  );
  root.setAttribute("data-duration", String(end));
  return {
    content: serializeHtml(doc, source),
    bindings: copies.map((el) => ({
      domId: el.id,
      hfId: el.getAttribute("data-hf-id")!,
    })),
    delta,
  };
}
