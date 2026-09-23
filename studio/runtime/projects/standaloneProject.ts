import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

export const STANDALONE_PROJECT_ID = "MpVFX";

export const LEGACY_STANDALONE_COMPOSITION_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>My Video</title>
    <style>
      html,
      body {
        width: 1920px;
        height: 1080px;
        margin: 0;
        overflow: hidden;
        background: #0a0a0b;
      }

      #root {
        position: relative;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-hf-id="hf-root"
      data-composition-id="main"
      data-start="0"
      data-duration="5"
      data-width="1920"
      data-height="1080"
    ></div>
  </body>
</html>
`;

export function createStandaloneCompositionSource(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>My Video</title>
    <style>
      html,
      body {
        width: 1920px;
        height: 1080px;
        margin: 0;
        overflow: hidden;
        background: #0a0a0b;
      }

      #root {
        position: relative;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
      }
    </style>
    <script src="vendor/gsap.min.js"></script>
  </head>
  <body>
    <div
      id="root"
      data-hf-id="hf-root"
      data-composition-id="main"
      data-start="0"
      data-duration="5"
      data-width="1920"
      data-height="1080"
    ></div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}

const STANDALONE_COMPOSITION_SOURCE_WITHOUT_REGISTRY_INIT = createStandaloneCompositionSource().replace(
  "      window.__timelines = window.__timelines || {};\n",
  "",
);

function installedGsapSourcePath(): string {
  return createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
}

function ensureLocalGsap(projectDir: string, gsapSourcePath: string): void {
  const vendorDir = join(projectDir, "vendor");
  const destination = join(vendorDir, "gsap.min.js");
  if (existsSync(destination)) return;
  mkdirSync(vendorDir, { recursive: true });
  try {
    copyFileSync(gsapSourcePath, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function ensureStandaloneProject(
  projectsDir: string,
  options: { gsapSourcePath?: string } = {},
): {
  created: boolean;
  id: string;
} {
  const projectDir = join(projectsDir, STANDALONE_PROJECT_ID);
  const indexPath = join(projectDir, "index.html");
  const gsapSourcePath = options.gsapSourcePath ?? installedGsapSourcePath();

  if (existsSync(indexPath)) {
    const existingSource = readFileSync(indexPath, "utf-8");
    if (
      existingSource === LEGACY_STANDALONE_COMPOSITION_SOURCE ||
      existingSource === STANDALONE_COMPOSITION_SOURCE_WITHOUT_REGISTRY_INIT
    ) {
      ensureLocalGsap(projectDir, gsapSourcePath);
      writeFileSync(indexPath, createStandaloneCompositionSource(), "utf-8");
    } else if (existingSource.includes('<script src="vendor/gsap.min.js"></script>')) {
      ensureLocalGsap(projectDir, gsapSourcePath);
    }
    return { created: false, id: STANDALONE_PROJECT_ID };
  }

  mkdirSync(projectDir, { recursive: true });
  ensureLocalGsap(projectDir, gsapSourcePath);
  writeFileSync(indexPath, createStandaloneCompositionSource(), {
    encoding: "utf-8",
    flag: "wx",
  });
  return { created: true, id: STANDALONE_PROJECT_ID };
}
