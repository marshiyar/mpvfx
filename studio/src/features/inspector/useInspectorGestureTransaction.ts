import { useCallback, useEffect, useRef, useState } from "react";

function isPromiseCommit(result: void | Promise<unknown>): result is Promise<unknown> {
  return Boolean(result && typeof result.then === "function");
}

/** One owner for continuous inspector edits: preview freely, persist once. */
export function useInspectorGestureTransaction<T>({
  sourceValue,
  onPreview,
  onCommit,
  onPreviewEnd,
  isEqual,
}: {
  sourceValue: T;
  onPreview: (value: T) => void;
  onCommit: (value: T) => void | Promise<unknown>;
  onPreviewEnd?: () => void;
  isEqual?: (left: T, right: T) => boolean;
}) {
  const valuesEqual = isEqual ?? Object.is;
  const sourceRef = useRef(sourceValue);
  const activeRef = useRef<{ before: T; latest: T } | null>(null);
  const previewRef = useRef(onPreview);
  const commitRef = useRef(onCommit);
  const previewEndRef = useRef(onPreviewEnd);
  const generationRef = useRef(0);
  const replacedPreviewGenerationRef = useRef<number | null>(null);
  const externalSourceRevisionRef = useRef(0);
  const pendingRef = useRef<{ before: T; latest: T } | null>(null);
  const awaitingSourceAckRef = useRef<{ generation: number; value: T } | null>(null);
  const lastSourceValueRef = useRef(sourceValue);
  const valuesEqualRef = useRef(valuesEqual);
  if (!Object.is(lastSourceValueRef.current, sourceValue)) {
    lastSourceValueRef.current = sourceValue;
    const matchesCurrentSource = valuesEqual(sourceRef.current, sourceValue);
    const matchesSourceAck = Boolean(
      awaitingSourceAckRef.current &&
        valuesEqual(awaitingSourceAckRef.current.value, sourceValue),
    );
    const matchesOptimisticValue =
      matchesCurrentSource ||
      Boolean(activeRef.current && valuesEqual(activeRef.current.latest, sourceValue)) ||
      Boolean(pendingRef.current && valuesEqual(pendingRef.current.latest, sourceValue)) ||
      matchesSourceAck;
    if (matchesSourceAck) awaitingSourceAckRef.current = null;
    if (!matchesOptimisticValue) {
      generationRef.current += 1;
      externalSourceRevisionRef.current += 1;
      if (activeRef.current) replacedPreviewGenerationRef.current = generationRef.current;
      activeRef.current = null;
      pendingRef.current = null;
      awaitingSourceAckRef.current = null;
      sourceRef.current = sourceValue;
    } else {
      sourceRef.current = sourceValue;
    }
  }
  valuesEqualRef.current = valuesEqual;
  previewRef.current = onPreview;
  commitRef.current = onCommit;
  previewEndRef.current = onPreviewEnd;

  useEffect(() => {
    const replacedGeneration = replacedPreviewGenerationRef.current;
    replacedPreviewGenerationRef.current = null;
    if (replacedGeneration === generationRef.current && !activeRef.current) {
      previewEndRef.current?.();
    }
  }, [sourceValue]);

  const begin = useCallback(() => {
    if (!activeRef.current) {
      generationRef.current += 1;
      activeRef.current = { before: sourceRef.current, latest: sourceRef.current };
    }
  }, []);

  const preview = useCallback((value: T) => {
    if (!activeRef.current) {
      generationRef.current += 1;
      activeRef.current = { before: sourceRef.current, latest: sourceRef.current };
    }
    activeRef.current.latest = value;
    previewRef.current(value);
  }, []);

  const rollbackCommit = useCallback((active: { before: T; latest: T }, generation: number) => {
    if (generation !== generationRef.current) return;
    pendingRef.current = null;
    if (awaitingSourceAckRef.current?.generation === generation) {
      awaitingSourceAckRef.current = null;
    }
    sourceRef.current = active.before;
    previewRef.current(active.before);
    previewEndRef.current?.();
  }, []);

  const settle = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active && !valuesEqualRef.current(active.before, active.latest)) {
      const generation = ++generationRef.current;
      sourceRef.current = active.latest;
      pendingRef.current = active;
      awaitingSourceAckRef.current = { generation, value: active.latest };
      try {
        const result = commitRef.current(active.latest);
        if (isPromiseCommit(result)) {
          void result.then(
            () => {
              if (generation === generationRef.current) pendingRef.current = null;
            },
            () => rollbackCommit(active, generation),
          );
        } else if (generation === generationRef.current) {
          pendingRef.current = null;
          // Success keeps the gesture's final preview until the source agrees.
          // Replaying its baseline here would undo the visible edit immediately
          // after committing it; only cancellation or failure should roll back.
        }
      } catch {
        rollbackCommit(active, generation);
        return;
      }
    }
    if (active) previewEndRef.current?.();
  }, [rollbackCommit]);

  const cancel = useCallback(() => {
    const hadReplacedPreview =
      replacedPreviewGenerationRef.current === generationRef.current;
    replacedPreviewGenerationRef.current = null;
    generationRef.current += 1;
    const active = activeRef.current;
    activeRef.current = null;
    if (active && !valuesEqualRef.current(active.before, active.latest)) {
      sourceRef.current = active.before;
      previewRef.current(active.before);
    }
    if (active || hadReplacedPreview) previewEndRef.current?.();
  }, []);

  useEffect(() => cancel, [cancel]);

  return { begin, preview, settle, cancel, activeRef, externalSourceRevisionRef };
}

export function useInspectorGestureDraft<T>({
  sourceValue,
  onPreview,
  onCommit,
  onPreviewEnd,
  isEqual,
}: {
  sourceValue: T;
  onPreview: (value: T) => void;
  onCommit: (value: T) => void | Promise<unknown>;
  onPreviewEnd?: () => void;
  isEqual?: (left: T, right: T) => boolean;
}) {
  const [draft, setDraft] = useState(sourceValue);
  const transaction = useInspectorGestureTransaction({
    sourceValue,
    onPreview: (next) => {
      setDraft(next);
      onPreview(next);
    },
    onCommit: (next) => {
      setDraft(next);
      return onCommit(next);
    },
    onPreviewEnd,
    isEqual,
  });

  useEffect(() => {
    if (!transaction.activeRef.current) setDraft(sourceValue);
  }, [sourceValue, transaction.activeRef]);

  return { draft, setDraft, transaction };
}
