const { assertPackagedMediaBinaries } = require("./scripts/verify-packaged-media-binaries.cjs");
const { assertPackagedRenderer } = require("./scripts/verify-packaged-renderer.cjs");
const { assertPackagedLegalResources } = require("./scripts/verify-packaged-legal.cjs");
const {
  assertPackagedRuntimeDependencies,
} = require("./scripts/verify-packaged-runtime-dependencies.cjs");

module.exports = {
  packagerConfig: {
    name: "MpVFX",
    executableName: "MpVFX",
    appBundleId: "com.mpvfx.editor",
    asar: {
      unpack:
        "**/node_modules/{ffmpeg-static,@ffprobe-installer/**,onnxruntime-node/**,sharp/**,@img/**,esbuild/**,@esbuild/**}/**",
    },
    extraResource: [".puppeteer-cache/chrome-headless-shell", "resources/legal"],
    ignore: [
      /^\/(?:src|desktop|tests|fixtures|data|cache|renders|scripts)(?:\/|$)/,
      /^\/\.puppeteer-cache(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/desktop-dist\/.*\.map$/,
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
