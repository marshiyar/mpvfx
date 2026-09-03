import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

function repositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("public repository release readiness", () => {
  it("ships the repository policy and maintenance documents", () => {
    for (const path of [
      "README.md",
      "LICENSE",
      "NOTICE",
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "PRIVACY.md",
      "SECURITY.md",
      "SUPPORT.md",
      "docs/ARCHITECTURE.md",
      "docs/GITHUB_SETUP.md",
      "docs/REMOTE_ASSETS.md",
      "docs/RELEASING.md",
      "third_party/licenses/GSAP-NOTICE.txt",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/dependabot.yml",
    ]) {
      expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
    }
  });

  it("licenses MpVFX source under Apache-2.0 while preventing npm publication", () => {
    const pkg = JSON.parse(repositoryFile("studio/package.json")) as {
      name?: string;
      license?: string;
      private?: boolean;
      publishConfig?: unknown;
    };
    const lock = JSON.parse(repositoryFile("studio/package-lock.json")) as {
      packages?: Record<string, { license?: string }>;
    };
    const license = repositoryFile("LICENSE");

    expect(pkg).toMatchObject({ name: "mpvfx", license: "Apache-2.0", private: true });
    expect(lock.packages?.[""]?.license).toBe("Apache-2.0");
    expect(pkg.publishConfig).toBeUndefined();
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("http://www.apache.org/licenses/");
    expect(repositoryFile("NOTICE")).toContain("Third-party material");
  });

  it("reserves the exact GitHub repository name mpvfx", () => {
    const setup = repositoryFile("docs/GITHUB_SETUP.md");

    expect(setup).toContain("repository name must be exactly `mpvfx`");
  });

  it("separates and completely attributes the Stack Overflow QA corpus", () => {
    const corpusPath = resolve(
      repositoryRoot,
      "third_party/stackexchange-video-qa/data/video-qa.jsonl",
    );
    const sourcePath = resolve(
      repositoryRoot,
      "third_party/stackexchange-video-qa/sources.jsonl",
    );
    expect(existsSync(resolve(repositoryRoot, "data_Q&A/data-1.jsonl"))).toBe(false);
    expect(existsSync(corpusPath)).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);

    const corpus = readFileSync(corpusPath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as {
        question_id: number;
        answers: Array<{ answer_id: number }>;
      });
    const sources = readFileSync(sourcePath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const expectedIds = new Set(
      corpus.flatMap((record) => [
        `question:${record.question_id}`,
        ...record.answers.map((answer) => `answer:${answer.answer_id}`),
      ]),
    );
    const attributedIds = new Set(
      sources.map((source) => `${source.post_type}:${source.post_id}`),
    );

    expect(attributedIds).toEqual(expectedIds);
    for (const source of sources) {
      expect(source.author).toEqual(expect.any(String));
      expect(source.source_url).toMatch(/^https:\/\/stackoverflow\.com\/(?:q(?:uestions)?\/|a\/)/u);
      expect(source.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(source.license).toMatch(/^CC BY-SA (?:2\.5|3\.0|4\.0)$/u);
      expect(source.license_url).toMatch(/^https:\/\/creativecommons\.org\/licenses\/by-sa\//u);
      expect(source.changes).toEqual(expect.any(String));
    }
  });

  it("keeps copied QA prose inside the separately licensed corpus", () => {
    const traceMap = [
      "studio/tests/qa/videoQaInvariantMap.part1.ts",
      "studio/tests/qa/videoQaInvariantMap.part2.ts",
      "studio/tests/qa/videoQaInvariantMap.part3.ts",
    ]
      .map(repositoryFile)
      .join("\n");

    expect(traceMap).not.toMatch(/\bevidence\s*:/u);
  });

  it("does not publish user projects, local agent state, generated output, or secrets", () => {
    const ignore = repositoryFile(".gitignore");
    for (const path of [
      ".agents/",
      ".codex/",
      ".env.*",
      "studio/fixtures/MpVFX/",
      "studio/fixtures/my-video/",
      "studio/fixtures/storyboard-sample/",
      "studio/node_modules/",
      "studio/dist/",
      "studio/desktop-dist/",
      "studio/out/",
      "studio/renders/",
    ]) {
      expect(ignore, path).toContain(path);
    }
  });

  it("denies personal media by default and publishes only the synthetic smoke video", () => {
    const privateMediaPaths = [
      "personal-media/private-video.mp4",
      "personal-media/private-audio.wav",
      "personal-media/private-thumbnail.png",
      "personal-media/private-captions.srt",
      "personal-media/private-grade.cube",
    ];
    for (const path of privateMediaPaths) {
      const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], {
        cwd: repositoryRoot,
      });
      expect(result.status, path).toBe(0);
    }

    const smokeVideo = "studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4";
    const smokeResult = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", smokeVideo],
      { cwd: repositoryRoot },
    );
    expect(smokeResult.status, smokeVideo).toBe(1);

    const publication = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(publication.status).toBe(0);
    const mediaFiles = publication.stdout
      .split("\0")
      .filter((path) => /\.(?:3dl|aac|ass|avi|bmp|cube|flac|gif|heic|heif|jpe?g|lut|m4a|m4v|mkv|mov|mp3|mp4|mpe?g|ogg|opus|png|srt|tiff?|vtt|wav|webm|webp)$/iu.test(path));
    expect(mediaFiles).toEqual([smokeVideo]);
    expect(
      createHash("sha256")
        .update(readFileSync(resolve(repositoryRoot, smokeVideo)))
        .digest("hex"),
    ).toBe("4662cef1ee4423640d4db8b8880ea889d6e0af6e4466d88f5ee15f2dc6d18030");
  });

  it("excludes the former upstream favicon bytes without reserving the favicon name", () => {
    const forbiddenDigest = "d7f1a4221e7a9855ae13dfb889357fa164eed33bea2f7f2c27ced532b5ae6bbc";
    const publication = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(publication.status).toBe(0);
    const matchingPaths = publication.stdout
      .split("\0")
      .filter((path) => path.endsWith(".svg"))
      .filter((path) => (
        createHash("sha256")
          .update(readFileSync(resolve(repositoryRoot, path)))
          .digest("hex") === forbiddenDigest
      ));
    expect(matchingPaths).toEqual([]);

    const ignoreRules = repositoryFile(".gitignore")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(ignoreRules).not.toContain("favicon.svg");
    expect(ignoreRules).not.toContain("studio/public/favicon.svg");
    expect(ignoreRules).not.toContain("*.svg");
  });

  it("excludes local AI-agent settings and conversation exports", () => {
    const ignore = repositoryFile(".gitignore");
    for (const pattern of [
      ".claude/",
      ".chatgpt/",
      ".cursor/",
      ".continue/",
      ".windsurf/",
      ".opencode/",
      ".gemini/",
      ".aider*",
      "/chat-history/",
      "/conversation-exports/",
      "/agent-transcripts/",
      "*.chatlog",
    ]) {
      expect(ignore, pattern).toContain(pattern);
    }
  });

  it("runs the publication privacy guard before commits and pushes", () => {
    for (const path of [".githooks/pre-commit", ".githooks/pre-push"]) {
      expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true);
      expect(repositoryFile(path), path).toContain("check-publication");
      expect(statSync(resolve(repositoryRoot, path)).mode & 0o111, path).not.toBe(0);
    }
    expect(repositoryFile(".githooks/check-publication")).toContain(
      "check-release-readiness.mjs",
    );
  });

  it("does not let generated-output rules hide application source directories", () => {
    const sourceFiles = [
      "studio/src/components/renders/RenderQueue.tsx",
      "studio/src/components/renders/useRenderQueue.ts",
    ];

    for (const path of sourceFiles) {
      const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], {
        cwd: repositoryRoot,
      });
      expect(result.status, path).toBe(1);
    }
  });

  it("keeps inherited analytics endpoints out of the source tree", () => {
    const telemetry = [
      repositoryFile("studio/src/telemetry/client.ts"),
      repositoryFile("studio/src/telemetry/policy.ts"),
      repositoryFile("studio/src/utils/studioTelemetry.ts"),
      repositoryFile("studio/src/components/feedback/StudioFeedbackCard.tsx"),
    ].join("\n");

    expect(telemetry).not.toContain(
      ["phc_zjjbX0PnWxERXrMHh", "kEJWj9A9BhGVLRReICgsfTMmpx"].join(""),
    );
    expect(telemetry).not.toContain(["calendar.app.google/", "yRHT7oPsHWcqFfFv5"].join(""));
  });

  it("pins remote model bytes and discloses their unresolved asset provenance", () => {
    const manager = repositoryFile("studio/desktop/backgroundRemoval/manager.ts");
    const provenance = repositoryFile("docs/REMOTE_ASSETS.md");
    const digest = "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c";

    expect(manager).toContain(digest);
    expect(manager).toContain("assertModelChecksum(model, temporary)");
    expect(provenance).toContain(digest);
    expect(provenance).toContain("does not currently carry a model-specific license");
  });

  it("validates installers on every desktop platform without publishing them", () => {
    const workflow = repositoryFile(".github/workflows/desktop.yml");

    expect(workflow).toContain("macos-15\n            arch: arm64");
    expect(workflow).toContain("macos-15-intel\n            arch: x64");
    expect(workflow).toContain("windows-2025\n            arch: x64");
    expect(workflow).toContain("ubuntu-24.04\n            arch: x64");
    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).not.toMatch(/\b(?:publish|release)\b/iu);
  });
});
