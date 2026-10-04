import { useState, useCallback, useEffect, useRef } from "react";
import { useMountEffect } from "./useMountEffect";
import type { AppToast } from "../lib/studioHelpers";
import { toastGroupKey } from "./toastPresentation";

interface ToastItem extends AppToast {
  id: number;
  groupKey: string;
  occurrences: number;
  details: string[];
  /** True while the exit animation plays, just before removal. */
  leaving?: boolean;
}

const AUTO_DISMISS_MS = 4000;
const EXIT_MS = 160;
const MAX_TOASTS = 3;

let nextToastId = 1;

/**
 * Stacked toasts (max 3). Info toasts auto-dismiss after 4s; error toasts
 * persist until explicitly dismissed. Routine info cannot evict a failure.
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const removeToast = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: number) => {
      clearTimer(id);
      // Mark leaving so the exit animation plays, then remove.
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      const timer = setTimeout(() => removeToast(id), EXIT_MS);
      timersRef.current.set(id, timer);
    },
    [clearTimer, removeToast],
  );

  const showToast = useCallback(
    (message: string, tone: AppToast["tone"] = "error") => {
      const id = nextToastId++;
      setToasts((prev) => {
        const groupKey = toastGroupKey(message, tone);
        const existing = prev.find((toast) =>
          !toast.leaving && toast.tone === tone && toast.groupKey === groupKey);
        if (existing) {
          if (tone !== "error") return prev;
          return prev.map((toast) => toast.id === existing.id ? {
            ...toast,
            occurrences: toast.occurrences + 1,
            details: toast.details.includes(message) ? toast.details : [...toast.details, message],
          } : toast);
        }
        if (tone !== "error" && prev.length >= MAX_TOASTS &&
          prev.every((toast) => toast.tone === "error")) return prev;
        const next = [...prev, { id, message, tone, groupKey, occurrences: 1, details: [message] }];
        // Keep actionable errors visible before transient info notices.
        while (next.length > MAX_TOASTS) {
          const oldestInfo = next.findIndex((toast) => toast.tone !== "error");
          const [dropped] = next.splice(oldestInfo < 0 ? 0 : oldestInfo, 1);
          if (dropped) clearTimer(dropped.id);
        }
        return next;
      });
    },
    [clearTimer],
  );

  // Only displayed info notices get an expiry timer. A repeated notice or one
  // discarded to keep errors visible must not leave a timer for a nonexistent id.
  useEffect(() => {
    const visibleIds = new Set(toasts.map((toast) => toast.id));
    for (const id of timersRef.current.keys()) {
      if (!visibleIds.has(id)) clearTimer(id);
    }
    for (const toast of toasts) {
      if (toast.tone === "error" || toast.leaving || timersRef.current.has(toast.id)) continue;
      timersRef.current.set(
        toast.id,
        setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS),
      );
    }
  }, [clearTimer, dismissToast, toasts]);

  useMountEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  });

  return { toasts, showToast, dismissToast };
}
