const {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  statSync,
} = require("node:fs");
const { join } = require("node:path");
const {
  assertExecutableFfprobe,
  assertExecutableFfmpeg,
  assertPinnedFfprobeFile,
  assertPinnedFfmpegFile,
} = require("./verify-redistributable-ffmpeg.cjs");

const MACH_CPU = new Map([
  [7, "ia32"],
  [12, "arm"],
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);
const ELF_MACHINE = new Map([
  [3, "ia32"],
  [40, "arm"],
  [62, "x64"],
  [183, "arm64"],
]);
const PE_MACHINE = new Map([
  [0x014c, "ia32"],
  [0x01c0, "arm"],
  [0x01c4, "arm"],
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

function machineName(map, value) {
  return map.get(value) || `unknown-0x${value.toString(16)}`;
}

function inspectMachO(buffer) {
  if (buffer.length < 8) return null;
  const littleMagic = buffer.readUInt32LE(0);
  const bigMagic = buffer.readUInt32BE(0);
  if (littleMagic === 0xfeedface || littleMagic === 0xfeedfacf) {
    return { platform: "darwin", architectures: [machineName(MACH_CPU, buffer.readUInt32LE(4))] };
  }
  if (bigMagic === 0xfeedface || bigMagic === 0xfeedfacf) {
    return { platform: "darwin", architectures: [machineName(MACH_CPU, buffer.readUInt32BE(4))] };
  }

  const fatBigEndian = bigMagic === 0xcafebabe || bigMagic === 0xcafebabf;
  const fatLittleEndian = littleMagic === 0xcafebabe || littleMagic === 0xcafebabf;
  if (!fatBigEndian && !fatLittleEndian) return null;
  const read32 = fatBigEndian
    ? (offset) => buffer.readUInt32BE(offset)
    : (offset) => buffer.readUInt32LE(offset);
  const canonicalMagic = fatBigEndian ? bigMagic : littleMagic;
  const stride = canonicalMagic === 0xcafebabf ? 32 : 20;
  const count = Math.min(read32(4), 32);
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * stride;
    if (offset + 4 > buffer.length) break;
    architectures.push(machineName(MACH_CPU, read32(offset)));
  }
  return { platform: "darwin", architectures: [...new Set(architectures)] };
}

function inspectElf(buffer) {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46
  ) {
    return null;
  }
  const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18);
  return { platform: "linux", architectures: [machineName(ELF_MACHINE, machine)] };
}

function inspectPortableExecutable(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset + 6 > buffer.length ||
    buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    return null;
  }
  return {
    platform: "win32",
    architectures: [machineName(PE_MACHINE, buffer.readUInt16LE(peOffset + 4))],
  };
}

function inspectExecutableBuffer(buffer) {
  return inspectMachO(buffer) || inspectElf(buffer) || inspectPortableExecutable(buffer);
}

function assertExecutableBufferMatchesTarget(name, buffer, platform, arch) {
  const detected = inspectExecutableBuffer(buffer);
  const actual = detected
    ? `${detected.platform}-${detected.architectures.join("/")}`
    : "unknown executable format";
  if (!detected || detected.platform !== platform || !detected.architectures.includes(arch)) {
    throw new Error(`${name} must target ${platform}-${arch}, but the bundled file is ${actual}`);
  }
}

function readExecutableHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function packagedMediaBinaryPaths(outputPath, platform, arch) {
  const windows = platform === "win32";
  const resourcesPath =
    platform === "darwin"
      ? join(outputPath.endsWith(".app") ? outputPath : join(outputPath, "MpVFX.app"), "Contents", "Resources")
      : join(outputPath, "resources");
  const modulesPath = join(resourcesPath, "app.asar.unpacked", "node_modules");
  return {
    ffmpeg: join(modulesPath, "ffmpeg-static", windows ? "ffmpeg.exe" : "ffmpeg"),
    ffprobe: join(
      modulesPath,
      "@ffprobe-installer",
      `${platform}-${arch}`,
      windows ? "ffprobe.exe" : "ffprobe",
    ),
  };
}

function assertUsableFile(name, path, platform, arch) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Packaged ${name} is missing at "${path}"`);
  }
  if (platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`Packaged ${name} is not executable at "${path}"`);
    }
  }
  assertExecutableBufferMatchesTarget(name, readExecutableHeader(path), platform, arch);
}

function assertPackagedMediaBinaries(packageResult) {
  for (const outputPath of packageResult.outputPaths) {
    const paths = packagedMediaBinaryPaths(
      outputPath,
      packageResult.platform,
      packageResult.arch,
    );
    assertUsableFile("FFmpeg", paths.ffmpeg, packageResult.platform, packageResult.arch);
    assertUsableFile("FFprobe", paths.ffprobe, packageResult.platform, packageResult.arch);
    assertExecutableFfmpeg(paths.ffmpeg);
    assertExecutableFfprobe(paths.ffprobe);
  }
}

function assertPreparedMediaBinaries(buildPath, platform, arch) {
  const ffmpeg = join(
    buildPath,
    "node_modules",
    "ffmpeg-static",
    platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const ffprobe = join(
    buildPath,
    "node_modules",
    "@ffprobe-installer",
    `${platform}-${arch}`,
    platform === "win32" ? "ffprobe.exe" : "ffprobe",
  );
  assertPinnedFfmpegFile(ffmpeg, platform, arch);
  assertPinnedFfprobeFile(ffprobe, platform, arch);
}

function assertPreparedFfmpeg(buildPath, platform, arch) {
  assertPreparedMediaBinaries(buildPath, platform, arch);
}

module.exports = {
  assertExecutableBufferMatchesTarget,
  assertPackagedMediaBinaries,
  assertPreparedMediaBinaries,
  assertPreparedFfmpeg,
  inspectExecutableBuffer,
  packagedMediaBinaryPaths,
};
