const {
  assertPackagedMediaBinaries,
  assertPreparedMediaBinaries,
} = require("../../scripts/verification_checks/verify-packaged-media-binaries.cjs");
const { assertPackagedRenderer } = require("../../scripts/verification_checks/verify-packaged-renderer.cjs");
const { assertPackagedLegalResources } = require("../../scripts/verification_checks/verify-packaged-legal.cjs");
const {
  assertPackagedRuntimeDependencies,
} = require("../../scripts/verification_checks/verify-packaged-runtime-dependencies.cjs");

module.exports = {
  packagerConfig: {
    name: "MpVFX",
    executableName: "MpVFX",
    appBundleId: "com.mpvfx.editor",
    extendInfo: { LSMinimumSystemVersion: "15.0" },
    asar: {
      unpack:
        "**/node_modules/{ffmpeg-static,@ffprobe-installer/**,@img/**,esbuild/**,@esbuild/**}/**",
    },
    extraResource: [".puppeteer-cache/chrome-headless-shell", "legal"],
    ignore: [
      /^\/(?:src|desktop|runtime|shared|tests|fixtures|data|cache|renders|scripts|legal)(?:\/|$)/,
      /^\/\.puppeteer-cache(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/\.configurations(?:\/|$)/,
      /^\/\.build\/(?!dist(?:\/|$)|desktop-dist(?:\/|$))/,
      /^\/\.build\/desktop-dist\/.*\.map$/,
      /^\/.*\.test\.[cm]?[jt]sx?$/,
      /^\/(?:vite|vitest|tsup|tailwind|postcss)\..*\.[cm]?[jt]s$/,
      /^\/tsconfig(?:\..+)?\.json$/,
    ],
    win32metadata: {
      CompanyName: "MpVFX",
      FileDescription: "MpVFX Video Editor",
      ProductName: "MpVFX",
    },
  },
  rebuildConfig: {},
  hooks: {
    packageAfterPrune: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      assertPreparedMediaBinaries(buildPath, platform, arch);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      assertPackagedMediaBinaries(packageResult);
      assertPackagedRuntimeDependencies(packageResult);
      assertPackagedRenderer(packageResult);
      assertPackagedLegalResources(packageResult);
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: { format: "ULFO" },
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "MpVFX",
        authors: "MpVFX",
        description: "Media-first nonlinear video editor",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "mpvfx",
          bin: "MpVFX",
          productName: "MpVFX",
          categories: ["AudioVideo", "Video"],
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: "mpvfx",
          bin: "MpVFX",
          productName: "MpVFX",
          categories: ["AudioVideo", "Video"],
        },
      },
    },
  ],
};
