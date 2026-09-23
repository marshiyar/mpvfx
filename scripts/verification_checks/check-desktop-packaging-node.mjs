import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (major !== 24) {
  console.error(
    `MpVFX packaging uses Node 24 LTS (found ${process.version}). Use the Node version in studio/.configurations/.nvmrc.`,
  );
  process.exit(1);
}

const { assertInstalledRedistributableFfmpeg } = require(
  "./verify-redistributable-ffmpeg.cjs",
);
assertInstalledRedistributableFfmpeg(process.platform, process.arch);
