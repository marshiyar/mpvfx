import { useCallback, useEffect, useRef } from "react";
import { addStudioPendingEditFlushListener, trackStudioPendingEdit } from "../../history/studioPendingEdits";
import type { Composition } from "@hyperframes/sdk";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import type { DomEditSelection } from "../../canvas/domEditingTypes";
import {
  sdkGsapTweenPersist,
  sdkGsapRemovePropertyPersist,
  cutoverCommittedOrThrow,
  type CutoverDeps,
} from "../../legacy/sdkCutover";
import { extractGsapScriptText } from "../../legacy/gsapSoftReload";
import { PROPERTY_DEFAULTS } from "./gsapScriptCommitHelpers";
import type { SafeGsapCommitMutation } from "./gsapScriptCommitTypes";

const DEBOUNCE_MS = 150;

/**
 * The SDK `setGsapTween` 'set' path REPLACES a tween's editable property set
 * (engine `handleSetGsapTween` → `updateAnimationInScript`), so sending only the
 * single edited key would silently drop the tween's other animated props. Mirror
 * the legacy server path (`{ ...anim.properties, [property]: val }`): read the
 * tween's CURRENT properties from the in-memory SDK doc and merge the one edit in,
 * so REPLACE semantics preserve siblings. Returns the single-key map unchanged
 * when the tween/script can't be found (best-effort; before===after then falls
 * back to the server path).
 */
export function mergeTweenProperties(
  sdkSession: Composition,
  animationId: string,
  edited: Record<string, number | string>,
  kind: "to" | "from",
): Record<string, number | string> {
  try {
    const script = extractGsapScriptText(sdkSession.serialize());
    if (!script) return { ...edited };
    const anim = parseGsapScriptAcorn(script).animations.find((a) => a.id === animationId);
    if (!anim) return { ...edited };
    const existing = kind === "from" ? (anim.fromProperties ?? {}) : anim.properties;
    return { ...existing, ...edited };
  } catch {
    return { ...edited };
  }
}

interface SdkPropertyDeps {
  persistMutation?: SafeGsapCommitMutation;
  sdkSession?: Composition | null;
  sdkDeps?: CutoverDeps | null;
  activeCompPath?: string | null;
  onFlushError?: (
    error: unknown,
    selection: DomEditSelection,
    mutation: Record<string, unknown>,
    label: string,
  ) => void;
}

export function useGsapPropertyDebounce(
  commitMutationSafely: SafeGsapCommitMutation,
  sdk?: SdkPropertyDeps,
) {
  interface PendingEdit {
    selection: DomEditSelection;
    animationId: string;
    property: string;
    value: number | string;
    sdk: SdkPropertyDeps | undefined;
    persist: SafeGsapCommitMutation;
  }
  const pendingRef = useRef(new Map<string, PendingEdit>());
  const persistenceScopes = useRef(new WeakMap<SafeGsapCommitMutation, number>());
  const nextPersistenceScope = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;

  const flushPendingPropertyEdit = useCallback((): Promise<void> => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    if (inFlightRef.current) return inFlightRef.current;
    const operation = (async () => {
      while (pendingRef.current.size) {
        const [key, pending] = pendingRef.current.entries().next().value!;
        const { selection, animationId, property, value } = pending;
        const mutation = { type: "update-property", animationId, property, value };
        const label = `Edit GSAP ${property}`;
        try {
          const { sdkSession, sdkDeps, activeCompPath } = pending.sdk ?? {};
          let handled = false;
          if (sdkSession && sdkDeps) {
            handled = cutoverCommittedOrThrow(await sdkGsapTweenPersist(
              selection.sourceFile || activeCompPath || "index.html",
              { kind: "set", animationId, properties: { properties: mergeTweenProperties(sdkSession, animationId, { [property]: value }, "to") } },
              sdkSession, sdkDeps, { label, coalesceKey: `gsap:${animationId}:${property}` },
            ));
          }
          if (!handled) await pending.persist(selection, mutation, { label, coalesceKey: `gsap:${animationId}:${property}`, softReload: true });
          if (pendingRef.current.get(key) === pending) pendingRef.current.delete(key);
        } catch (error) {
          pending.sdk?.onFlushError?.(error, selection, mutation, label);
          throw error;
        }
      }
    })();
    inFlightRef.current = operation;
    const clear = () => { if (inFlightRef.current === operation) inFlightRef.current = null; };
    void operation.then(clear, clear);
    trackStudioPendingEdit(operation);
    return operation;
  }, []);

  const updateGsapProperty = useCallback((selection: DomEditSelection, animationId: string, property: string, value: number | string) => {
    const currentSdk = sdkRef.current;
    const persist = currentSdk?.persistMutation ?? commitMutationSafely;
    let scope = persistenceScopes.current.get(persist);
    if (scope === undefined) {
      scope = ++nextPersistenceScope.current;
      persistenceScopes.current.set(persist, scope);
    }
    const key = JSON.stringify([scope, selection.sourceFile ?? currentSdk?.activeCompPath, animationId, property]);
    pendingRef.current.set(key, { selection, animationId, property, value, sdk: currentSdk, persist });
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => { void flushPendingPropertyEdit().catch(() => {}); }, DEBOUNCE_MS);
  }, [commitMutationSafely, flushPendingPropertyEdit]);

  useEffect(() => {
    const removeFlush = addStudioPendingEditFlushListener(flushPendingPropertyEdit);
    return () => {
      removeFlush();
      void flushPendingPropertyEdit().catch(() => {});
    };
  }, [flushPendingPropertyEdit]);

  // fallow-ignore-next-line complexity
  const addGsapProperty = useCallback(
    // fallow-ignore-next-line complexity
    async (selection: DomEditSelection, animationId: string, property: string) => {
      let defaultValue = PROPERTY_DEFAULTS[property] ?? 0;
      const el = selection.element;
      if (property === "width" || property === "height") {
        const rect = el.getBoundingClientRect();
        defaultValue = Math.round(property === "width" ? rect.width : rect.height);
      } else if (property === "opacity" || property === "autoAlpha") {
        const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
        // Use `|| 1` only as a non-finite fallback, not a falsy fallback: an
        // element currently at opacity 0 must seed 0, not 1.
        const current = cs ? Number.parseFloat(cs.opacity) : Number.NaN;
        defaultValue = Number.isFinite(current) ? current : 1;
      }
      const { sdkSession, sdkDeps, activeCompPath } = sdkRef.current ?? {};
      if (sdkSession && sdkDeps) {
        const targetPath = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapTweenPersist(
          targetPath,
          {
            kind: "set",
            animationId,
            properties: {
              properties: mergeTweenProperties(
                sdkSession,
                animationId,
                { [property]: defaultValue },
                "to",
              ),
            },
          },
          sdkSession,
          sdkDeps,
          { label: `Add GSAP ${property}` },
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      commitMutationSafely(
        selection,
        { type: "add-property", animationId, property, defaultValue },
        { label: `Add GSAP ${property}` },
      );
    },
    [commitMutationSafely],
  );

  const removeProperty = useCallback(
    async (selection: DomEditSelection, animationId: string, property: string, from: boolean) => {
      const { sdkSession, sdkDeps, activeCompPath } = sdkRef.current ?? {};
      if (sdkSession && sdkDeps) {
        const targetPath = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapRemovePropertyPersist(
          targetPath,
          animationId,
          property,
          from,
          sdkSession,
          sdkDeps,
          { label: `Remove GSAP ${from ? `from-${property}` : property}` },
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      if (from) {
        commitMutationSafely(
          selection,
          { type: "remove-from-property", animationId, property },
          {
            label: `Remove GSAP from-${property}`,
          },
        );
      } else {
        commitMutationSafely(
          selection,
          { type: "remove-property", animationId, property },
          {
            label: `Remove GSAP ${property}`,
          },
        );
      }
    },
    [commitMutationSafely],
  );

  const removeGsapProperty = useCallback(
    (selection: DomEditSelection, animationId: string, property: string) =>
      removeProperty(selection, animationId, property, false),
    [removeProperty],
  );

  const updateGsapFromProperty = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      property: string,
      value: number | string,
    ) => {
      const { sdkSession, sdkDeps, activeCompPath } = sdkRef.current ?? {};
      if (sdkSession && sdkDeps) {
        const targetPath = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapTweenPersist(
          targetPath,
          {
            kind: "set",
            animationId,
            properties: {
              fromProperties: mergeTweenProperties(
                sdkSession,
                animationId,
                { [property]: value },
                "from",
              ),
            },
          },
          sdkSession,
          sdkDeps,
          {
            label: `Edit GSAP from-${property}`,
            coalesceKey: `gsap:${animationId}:from:${property}`,
          },
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      commitMutationSafely(
        selection,
        { type: "update-from-property", animationId, property, value },
        {
          label: `Edit GSAP from-${property}`,
          coalesceKey: `gsap:${animationId}:from:${property}`,
        },
      );
    },
    [commitMutationSafely],
  );

  const addGsapFromProperty = useCallback(
    async (selection: DomEditSelection, animationId: string, property: string) => {
      const defaultValue = PROPERTY_DEFAULTS[property] ?? 0;
      const { sdkSession, sdkDeps, activeCompPath } = sdkRef.current ?? {};
      if (sdkSession && sdkDeps) {
        const targetPath = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapTweenPersist(
          targetPath,
          {
            kind: "set",
            animationId,
            properties: {
              fromProperties: mergeTweenProperties(
                sdkSession,
                animationId,
                { [property]: defaultValue },
                "from",
              ),
            },
          },
          sdkSession,
          sdkDeps,
          { label: `Add GSAP from-${property}` },
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      commitMutationSafely(
        selection,
        { type: "add-from-property", animationId, property, defaultValue },
        { label: `Add GSAP from-${property}` },
      );
    },
    [commitMutationSafely],
  );

  const removeGsapFromProperty = useCallback(
    (selection: DomEditSelection, animationId: string, property: string) =>
      removeProperty(selection, animationId, property, true),
    [removeProperty],
  );

  return {
    updateGsapProperty,
    addGsapProperty,
    removeGsapProperty,
    updateGsapFromProperty,
    addGsapFromProperty,
    removeGsapFromProperty,
  };
}
