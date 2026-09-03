import { isAbsolute, relative, resolve, sep } from "node:path";

interface DurableCommittedFile {
  readonly path: string;
  readonly after: string | null;
}

interface RegisterDurableWriteReceiptsInput {
  readonly projectRoot: string;
  readonly files: readonly DurableCommittedFile[];
  readonly writeTokens: Readonly<Record<string, string>>;
}

export interface DurableWriteWatcherReceipt {
  readonly path: string;
  readonly version: string;
  readonly writeToken: string;
}

interface DurableWriteReceiptRegistryOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface PendingReceipt {
  readonly content: string | null;
  readonly token: string;
  readonly expiresAt: number;
}

const isWithin = (root: string, candidate: string): boolean => {
  const offset = relative(root, candidate);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
};

/**
 * Bridges direct crash-journal writes into the existing browser self-write
 * protocol. Matching includes exact bytes, so a racing external edit is never
 * suppressed merely because it touched the same path.
 */
export function createDurableWriteReceiptRegistry(
  options: DurableWriteReceiptRegistryOptions = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const pending = new Map<string, PendingReceipt[]>();

  const prune = (timestamp: number): void => {
    for (const [path, entries] of pending) {
      const live = entries.filter((entry) => entry.expiresAt > timestamp);
      if (live.length > 0) pending.set(path, live);
      else pending.delete(path);
    }
  };

  return {
    register(input: RegisterDurableWriteReceiptsInput): void {
      const timestamp = now();
      prune(timestamp);
      const root = resolve(input.projectRoot);
      for (const file of input.files) {
        const token = input.writeTokens[file.path];
        if (typeof token !== "string" || token.length === 0) continue;
        const target = resolve(root, file.path);
        if (!isWithin(root, target)) continue;
        const entries = pending.get(target) ?? [];
        entries.push({ content: file.after, token, expiresAt: timestamp + ttlMs });
        pending.set(target, entries);
      }
    },

    consume(
      filePath: string,
      currentContent: string | null,
      version: string,
    ): DurableWriteWatcherReceipt | null {
      prune(now());
      const target = resolve(filePath);
      const entries = pending.get(target);
      if (!entries) return null;
      // The current filesystem bytes may already reflect a later queued commit;
      // match by content rather than assuming watcher delivery order.
      const matchIndex = entries.findIndex((entry) => entry.content === currentContent);
      if (matchIndex < 0) return null;
      const [match] = entries.splice(matchIndex, 1);
      if (entries.length === 0) pending.delete(target);
      else pending.set(target, entries);
      return { path: target, version, writeToken: match!.token };
    },
  };
}
