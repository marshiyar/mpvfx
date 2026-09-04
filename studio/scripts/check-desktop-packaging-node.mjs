import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (major !== 22) {
  console.error(
    `Electron packaging requires Node 22 LTS (found ${process.version}). Run \"nvm use\" in studio first.`,
  );
  process.exit(1);
}

const { assertInstalledRedistributableFfmpeg } = require(
  "./verify-redistributable-ffmpeg.cjs",
);
assertInstalledRedistributableFfmpeg(process.platform, process.arch);
