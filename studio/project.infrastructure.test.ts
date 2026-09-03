import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const studioRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(studioRoot, "..");
const hookPath = join(projectRoot, "scripts/protect-user-projects.py");

function runHook(command: string) {
  return spawnSync("python3", [hookPath], {
    cwd: projectRoot,
    encoding: "utf-8",
    input: JSON.stringify({ tool_input: { command } }),
  });
}

describe("standalone project infrastructure", () => {
  it("blocks destructive shell commands against user project files", () => {
    const result = runHook("rm -rf studio/fixtures/my-video");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ continue: false });
  });

  it("allows read-only inspection and generated metadata cleanup", () => {
    expect(runHook("rg data-composition-id studio/fixtures/my-video/index.html").stdout).toBe("");
    expect(runHook("rm -f studio/fixtures/.DS_Store").stdout).toBe("");
  });

  it("removes the detached frontend stub and ignores regenerable metadata", () => {
    expect(existsSync(join(studioRoot, "frontend"))).toBe(false);
    const ignoreRules = readFileSync(join(studioRoot, ".gitignore"), "utf-8").split(/\r?\n/);
    expect(ignoreRules).toContain(".DS_Store");
    expect(ignoreRules).toContain("fixtures/**/.thumbnails/");
  });

  it("uses npm metadata without Bun fallbacks", () => {
    expect(existsSync(join(studioRoot, "package-lock.json"))).toBe(true);
    expect(existsSync(join(studioRoot, "bun.lock"))).toBe(false);

    const packageJson = JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf-8"));
    expect(packageJson.exports["."]).not.toHaveProperty("bun");
    expect(packageJson.exports["./tailwind-preset"]).not.toHaveProperty("bun");

    const subpaths = readFileSync(join(studioRoot, "package-subpaths.json"), "utf-8");
    expect(subpaths).not.toMatch(/\bbun\b/);
    expect(readFileSync(join(studioRoot, "vite.adapter.ts"), "utf-8")).not.toMatch(/bun run/);
  });

  it("presents itself as a standalone video editor", () => {
    const browserShell = readFileSync(join(studioRoot, "index.html"), "utf-8");
    const readme = readFileSync(join(studioRoot, "README.md"), "utf-8");
    const packageJson = JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf-8"));

    expect(browserShell).toContain("<title>MpVFX</title>");
    expect(browserShell).not.toContain(["Hyper", "Frames Studio"].join(""));
    expect(readme).toMatch(/^# MpVFX/);
    expect(packageJson.name).toBe("mpvfx");
  });

  it("uses MpVFX branding for project-owned metadata and public copy", () => {
    const packageJson = JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf-8"));
    const packageLock = JSON.parse(readFileSync(join(studioRoot, "package-lock.json"), "utf-8"));
    const subpaths = JSON.parse(
      readFileSync(join(studioRoot, "package-subpaths.json"), "utf-8"),
    );
    const ownedCopy = [
      "README.md",
      "src/webmcp/tools/lookTools.ts",
      "src/webmcp/tools/selectionTools.ts",
      "src/telemetry/client.ts",
      "src/components/ui/index.ts",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .join("\n");

    expect(packageJson.name).toBe("mpvfx");
    expect(packageJson.repository).toBeUndefined();
    expect(packageLock.name).toBe("mpvfx");
    expect(packageLock.packages[""].name).toBe("mpvfx");
    expect(subpaths.package).toBe("mpvfx");
    expect(ownedCopy).toContain("MpVFX");
    expect(ownedCopy).not.toMatch(new RegExp(["hyper", "frames|hey", "gen"].join(""), "i"));
    expect(existsSync(join(studioRoot, "src/components/ui/MpVfxLoader.tsx"))).toBe(true);
    expect(
      existsSync(join(studioRoot, "src/components/ui", ["Hyper", "framesLoader.tsx"].join(""))),
    ).toBe(false);
    expect(readFileSync(join(studioRoot, "vite.config.ts"), "utf-8")).toContain(
      'return "mpvfx-player"',
    );
  });

  it("keeps the former upstream mark out of interface icons", () => {
    const timelineIconDir = join(studioRoot, "public/icons/timeline");
    const interfaceIcons = [
      "src/components/ui/MpVfxLoader.tsx",
      "src/player/components/PlayerControls.tsx",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .concat(
        readdirSync(timelineIconDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".svg"))
          .map((entry) => readFileSync(join(timelineIconDir, entry.name), "utf-8")),
      )
      .join("\n");

    expect(interfaceIcons).not.toContain("M87.5129 57.5141");
    expect(interfaceIcons).not.toContain("M10.1851 57.8021");
  });

  it("ships no agent-only controls or instructions in the editor UI", () => {
    const agentOnlyComponents = [
      "src/components/AskAgentModal.tsx",
      "src/components/sidebar/PromptPreviewModal.tsx",
      "src/components/storyboard/AgentChatMessageButton.tsx",
      "src/player/components/EditModal.tsx",
    ];
    for (const relativePath of agentOnlyComponents) {
      expect(existsSync(join(studioRoot, relativePath))).toBe(false);
    }

    const userFacingSources = [
      "src/components/editor/PropertyPanelFlatFooter.tsx",
      "src/components/editor/PropertyPanelFlatHeader.tsx",
      "src/components/sidebar/BlocksTab.tsx",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .join("\n");

    expect(userFacingSources).not.toMatch(
      /ask agent|copy to agent|AI agent|agent chat|your agent|agent prompt|agent builds|updated by your agent/i,
    );
  });

  it("keeps framework branding and CLI handoffs out of the standalone UI", () => {
    const standaloneUiSources = [
      "src/components/StudioHeader.tsx",
      "src/components/editor/PropertyPanel.tsx",
      "src/components/feedback/StudioFeedbackCard.tsx",
      "src/components/renders/useRenderQueue.ts",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .join("\n");

    const formerFramework = ["hyper", "frames"].join("");
    expect(standaloneUiSources).not.toMatch(
      new RegExp(
        `${formerFramework}Logo|recommend ${formerFramework}|${formerFramework} team|npx ${formerFramework} render|${formerFramework} render|paste into any AI agent`,
        "i",
      ),
    );
  });

  it("ships an NLE without storyboard, source-authoring, or template workflow UI", () => {
    const obsoleteAuthoringSurfaces = [
      "src/components/storyboard",
      "src/contexts/ViewModeContext.tsx",
      "src/hooks/useStoryboard.ts",
      "src/hooks/useProjectSignaturePoll.ts",
      "src/components/editor/SourceEditor.tsx",
      "src/components/editor/FileTree.tsx",
      "src/components/editor/FileTreeIcons.tsx",
      "src/components/editor/FileTreeNodes.tsx",
      "src/components/LintModal.tsx",
      "src/hooks/useLintModal.ts",
      "src/hooks/useConsoleErrorCapture.ts",
      "src/telemetry/agentRuntime.ts",
      "src/components/sidebar/GlobalAssetsView.tsx",
      "src/components/DesignPanelPromoteProvider.tsx",
      "src/components/editor/PromotableControl.tsx",
      "src/contexts/VariablePromoteContext.tsx",
      "src/contexts/variablePromoteHelpers.ts",
      "src/components/panels/VariablesPanel.tsx",
      "src/components/panels/VariablesDeclarationForm.tsx",
      "src/components/panels/VariablesBindElement.tsx",
      "src/components/panels/VariablesOtherCompositions.tsx",
      "src/components/panels/VariablesRowAction.tsx",
      "src/components/panels/VariablesValueControls.tsx",
      "src/hooks/useVariablesPersist.ts",
      "src/hooks/useProjectCompositionVariables.ts",
      "src/hooks/previewVariablesStore.ts",
      "src/components/panels/SlideshowPanel.tsx",
      "src/components/panels/SlideshowSubPanels.tsx",
      "src/components/panels/slideshowPanelHelpers.ts",
      "src/hooks/useSlideshowPersist.ts",
      "src/hooks/useSlideshowTabState.ts",
      "src/utils/setSlideshowManifest.ts",
    ];
    for (const relativePath of obsoleteAuthoringSurfaces) {
      expect(existsSync(join(studioRoot, relativePath)), relativePath).toBe(false);
    }

    const editorShellSources = [
      "src/App.tsx",
      "src/components/StudioHeader.tsx",
      "src/components/StudioLeftSidebar.tsx",
      "src/components/StudioRightPanel.tsx",
      "src/components/sidebar/LeftSidebar.tsx",
      "src/components/sidebar/AssetsTab.tsx",
      "src/components/StudioOverlays.tsx",
      "src/components/StudioSplash.tsx",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .join("\n");

    expect(editorShellSources).not.toMatch(
      /Storyboard|Advanced source editing|sidebar-panel-code|Template variables|Slideshow branching|Preview console errors|global cache|All projects|\bnpm run dev\b/,
    );

    const retiredWorkflowSupport = [
      "src/components/feedback/projectProvenance.ts",
      "src/player/components/CompositionThumbnail.tsx",
      "src/utils/editHistory.ts",
      "src/hooks/useCompositionContentLoader.ts",
    ]
      .map((relativePath) => readFileSync(join(studioRoot, relativePath), "utf-8"))
      .join("\n");
    expect(retiredWorkflowSupport).not.toMatch(
      /authoringSkill|project_authoring_skill|project_scaffolded|storyboard|source editor|"source"/i,
    );

    const packageJson = JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf-8"));
    const dependencies = packageJson.dependencies as Record<string, string>;
    expect(Object.keys(dependencies).some((name) => name.startsWith("@codemirror/"))).toBe(false);
    expect(dependencies).not.toHaveProperty("dompurify");
    expect(dependencies).not.toHaveProperty("marked");
  });
});
