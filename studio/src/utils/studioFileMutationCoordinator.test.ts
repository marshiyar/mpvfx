import { expect, it, vi } from "vitest";
import {
  serializeStudioFileMutations,
  waitForStudioFileMutations,
} from "./studioFileMutationCoordinator";
it("waits for an in-flight clip transaction and its history before undo can choose an entry", async () => {
  const writer = vi.fn(async () => undefined);
  let finish!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const history: string[] = [];
  const edit = serializeStudioFileMutations(
    writer,
    ["index.html", ".studio/project.json"],
    async () => {
      await deferred;
      history.push("cut clips");
    },
  );
  let undoReady = false;
  const drain = waitForStudioFileMutations(writer).then(() => {
    undoReady = true;
    expect(history.at(-1)).toBe("cut clips");
  });
  await Promise.resolve();
  expect(undoReady).toBe(false);
  finish();
  await edit;
  await drain;
  expect(undoReady).toBe(true);
});
