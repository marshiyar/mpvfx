/** Main-process ordering for all readers and writers of a project's source files. */
export function createProjectAccessQueue() {
  const pending = new Map<string, Promise<void>>();

  return {
    run<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
      const previous = pending.get(projectRoot) ?? Promise.resolve();
      const result = previous.then(operation);
      const settled = result.then(() => undefined, () => undefined);
      pending.set(projectRoot, settled);
      void settled.then(() => {
        if (pending.get(projectRoot) === settled) pending.delete(projectRoot);
      });
      return result;
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.all(pending.values());
    },
  };
}
