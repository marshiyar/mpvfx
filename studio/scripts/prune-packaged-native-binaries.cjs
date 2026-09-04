const {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} = require("node:fs");
const { join } = require("node:path");

function assertTargetPart(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9_-]+$/i.test(value)) {
    throw new Error(`Invalid packaging ${label}: ${JSON.stringify(value)}`);
  }
}

function prunePackagedNativeBinaries(buildPath, platform, arch) {
  assertTargetPart(platform, "platform");
  assertTargetPart(arch, "architecture");

  const nativeRoot = join(
    buildPath,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v3",
  );
  const targetRoot = join(nativeRoot, platform, arch);
  const targetBinding = join(targetRoot, "onnxruntime_binding.node");
  if (!existsSync(targetBinding) || !statSync(targetBinding).isFile()) {
    throw new Error(
      `ONNX Runtime does not provide a native binding for ${platform}-${arch} at "${targetBinding}"`,
    );
  }

  for (const platformEntry of readdirSync(nativeRoot, { withFileTypes: true })) {
    const platformPath = join(nativeRoot, platformEntry.name);
    if (!platformEntry.isDirectory() || platformEntry.name !== platform) {
      rmSync(platformPath, { recursive: true, force: true });
      continue;
    }

    for (const archEntry of readdirSync(platformPath, { withFileTypes: true })) {
      if (!archEntry.isDirectory() || archEntry.name !== arch) {
        rmSync(join(platformPath, archEntry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

module.exports = {
  prunePackagedNativeBinaries,
};
