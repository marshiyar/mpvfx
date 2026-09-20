// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  projectFileChangeScope,
  createFileChangeVersionFilter,
  createDurableWriteReceiptRegistry,
} from "./vite.durable-write-receipts";

describe("durable transaction watcher receipts", () => {
  it("matches every committed file by exact path and bytes with its own browser token", () => {
    const registry = createDurableWriteReceiptRegistry();
    const projectRoot = resolve("/tmp/project-a");
    registry.register({
      projectRoot,
      files: [
        { path: "index.html", after: "html-after" },
        { path: ".studio/project.json", after: "native-after" },
      ],
      writeTokens: {
        "index.html": "token-html",
        ".studio/project.json": "token-native",
      },
    });

    expect(
      registry.consume(
        resolve(projectRoot, "index.html"),
        "html-after",
        '"sha256:html"',
      ),
    ).toEqual({
      path: resolve(projectRoot, "index.html"),
      version: '"sha256:html"',
      writeToken: "token-html",
    });
    expect(
      registry.consume(
        resolve(projectRoot, ".studio/project.json"),
        "native-after",
        '"sha256:native"',
      ),
    ).toEqual({
      path: resolve(projectRoot, ".studio/project.json"),
      version: '"sha256:native"',
      writeToken: "token-native",
    });
  });

  it("never claims an external write with different bytes", () => {
    const registry = createDurableWriteReceiptRegistry();
    const root = resolve("/tmp/project-b");
    registry.register({
      projectRoot: root,
      files: [{ path: "index.html", after: "studio" }],
      writeTokens: { "index.html": "studio-token" },
    });

    expect(
      registry.consume(
        resolve(root, "index.html"),
        "external",
        "external-version",
      ),
    ).toBeNull();
    expect(
      registry.consume(resolve(root, "index.html"), "studio", "studio-version"),
    ).toMatchObject({
      writeToken: "studio-token",
    });
  });

  it("keeps overlapping committed contents independently until their watcher echo arrives", () => {
    const registry = createDurableWriteReceiptRegistry();
    const root = resolve("/tmp/project-c");
    registry.register({
      projectRoot: root,
      files: [{ path: "index.html", after: "first" }],
      writeTokens: { "index.html": "first-token" },
    });
    registry.register({
      projectRoot: root,
      files: [{ path: "index.html", after: "second" }],
      writeTokens: { "index.html": "second-token" },
    });

    expect(
      registry.consume(resolve(root, "index.html"), "second", "v2"),
    ).toMatchObject({
      writeToken: "second-token",
    });
    expect(
      registry.consume(resolve(root, "index.html"), "first", "v1"),
    ).toMatchObject({
      writeToken: "first-token",
    });
  });

  it("ignores unsafe paths, missing tokens, and expired claims", () => {
    let now = 1_000;
    const registry = createDurableWriteReceiptRegistry({
      now: () => now,
      ttlMs: 100,
    });
    const root = resolve("/tmp/project-d");
    registry.register({
      projectRoot: root,
      files: [
        { path: "../outside", after: "bad" },
        { path: "index.html", after: "owned" },
        { path: "no-token.html", after: "ignored" },
      ],
      writeTokens: { "../outside": "bad-token", "index.html": "owned-token" },
    });

    expect(
      registry.consume(resolve(root, "../outside"), "bad", "v"),
    ).toBeNull();
    expect(
      registry.consume(resolve(root, "no-token.html"), "ignored", "v"),
    ).toBeNull();
    now = 1_101;
    expect(
      registry.consume(resolve(root, "index.html"), "owned", "v"),
    ).toBeNull();
  });
});

describe("file watcher version deduplication", () => {
  it("publishes a save once even when the watcher sends a second tokenless event", () => {
    const shouldPublish = createFileChangeVersionFilter();
    expect(shouldPublish("/project/index.html", "v1")).toBe(true);
    expect(shouldPublish("/project/index.html", "v1")).toBe(false);
    expect(shouldPublish("/project/index.html", "external-v2")).toBe(true);
    expect(shouldPublish("/other/index.html", "v1")).toBe(true);
    expect(shouldPublish("/project/index.html", null)).toBe(true);
    expect(shouldPublish("/project/index.html", "external-v2")).toBe(true);
  });
});

describe("project file change ownership", () => {
  it("keeps project identity beside the relative receipt path", () => {
    expect(
      projectFileChangeScope(
        "/work/projects",
        "/work/projects/one/scenes/main.html",
      ),
    ).toEqual({ projectId: "one", path: "scenes/main.html" });
    expect(
      projectFileChangeScope(
        "/work/projects",
        "/work/projects/two/.studio/project.json",
      ),
    ).toEqual({ projectId: "two", path: ".studio/project.json" });
  });
  it("ignores generated caches, recovery history, and files outside the project root", () => {
    for (const path of [
      "one/.waveform-cache/wave.json",
      "one/.hyperframes/edits/history.json",
      "one/image.png",
      "../other/index.html",
    ])
      expect(
        projectFileChangeScope("/work/projects", `/work/projects/${path}`),
      ).toBeNull();
  });
});
