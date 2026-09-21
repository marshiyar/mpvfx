const {
  assertPackagedMediaBinaries,
  assertPreparedMediaBinaries,
} = require("./scripts/verify-packaged-media-binaries.cjs");
const { assertPackagedRenderer } = require("./scripts/verify-packaged-renderer.cjs");
const { assertPackagedLegalResources } = require("./scripts/verify-packaged-legal.cjs");
const { assertWindowsBrowserLaunchPolicy } = require("./scripts/apply-windows-browser-patch.cjs");
const { PRIVATE_FILE_PATTERN, PRIVATE_DIRECTORY_PATTERN, assertPackagedPrivacy, removePackagedFinderMetadata } = require("./scripts/verify-packaged-privacy.cjs");
const {
  assertPackagedRuntimeDependencies,
} = require("./scripts/verify-packaged-runtime-dependencies.cjs");

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
    extraResource: [".puppeteer-cache/chrome-headless-shell", "resources/legal"],
    ignore: [
      // Only compiled runtime inputs belong in the installed application.
      /^\/(?!(?:node_modules|dist|desktop-dist|resources)(?:\/|$)|package(?:-lock)?\.json$).+/,
      PRIVATE_FILE_PATTERN,
      PRIVATE_DIRECTORY_PATTERN,
      // Upstream's installer embeds an old signed-download example. It is not
      // used by the installed app; only index.js and the binary are runtime inputs.
      /^\/node_modules\/ffmpeg-static\/install\.js$/,
      /^\/(?:src|desktop|tests|fixtures|data|cache|renders|scripts)(?:\/|$)/,
      /^\/\.puppeteer-cache(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/(?:desktop-dist|dist)\/.*\.map$/,
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
      assertWindowsBrowserLaunchPolicy(buildPath);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      removePackagedFinderMetadata(packageResult);
      assertPackagedMediaBinaries(packageResult);
      assertPackagedRuntimeDependencies(packageResult);
      assertPackagedRenderer(packageResult);
      assertPackagedLegalResources(packageResult);
      assertPackagedPrivacy(packageResult);
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
