const {
  assertPackagedMediaBinaries,
  assertPreparedMediaBinaries,
} = require("./scripts/verify-packaged-media-binaries.cjs");
const { assertPackagedRenderer } = require("./scripts/verify-packaged-renderer.cjs");
const { assertPackagedLegalResources } = require("./scripts/verify-packaged-legal.cjs");
const {
  assertPackagedRuntimeDependencies,
} = require("./scripts/verify-packaged-runtime-dependencies.cjs");
const {
  prunePackagedNativeBinaries,
} = require("./scripts/prune-packaged-native-binaries.cjs");

const releaseBuild = process.env.MPVFX_RELEASE_BUILD === "1";

function requiredReleaseVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Official release packaging requires ${name}`);
  return value;
}

function releaseSigningConfig() {
  if (!releaseBuild) return { packager: {}, dmg: {}, squirrel: {} };
  if (process.platform === "darwin") {
    const identity = requiredReleaseVariable("MACOS_SIGNING_IDENTITY");
    return {
      packager: {
        osxSign: { identity, hardenedRuntime: true, continueOnError: false },
        osxNotarize: {
          appleId: requiredReleaseVariable("APPLE_ID"),
          appleIdPassword: requiredReleaseVariable("APPLE_APP_SPECIFIC_PASSWORD"),
          teamId: requiredReleaseVariable("APPLE_TEAM_ID"),
        },
      },
      dmg: {
        "code-sign": {
          "signing-identity": identity,
          identifier: "com.mpvfx.editor",
        },
      },
      squirrel: {},
    };
  }
  if (process.platform === "win32") {
    const windowsSign = {
      certificateFile: requiredReleaseVariable("WINDOWS_CERTIFICATE_FILE"),
      certificatePassword: requiredReleaseVariable("WINDOWS_CERTIFICATE_PASSWORD"),
      description: "MpVFX Video Editor",
      timestampServer: "http://timestamp.digicert.com",
      hashes: ["sha256"],
    };
    return { packager: { windowsSign }, dmg: {}, squirrel: { windowsSign } };
  }
  return { packager: {}, dmg: {}, squirrel: {} };
}

const signing = releaseSigningConfig();

module.exports = {
  packagerConfig: {
    name: "MpVFX",
    executableName: "MpVFX",
    appBundleId: "com.mpvfx.editor",
    extendInfo: { LSMinimumSystemVersion: "15.0" },
    ...signing.packager,
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
    packageAfterPrune: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      prunePackagedNativeBinaries(buildPath, platform, arch);
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
      config: { format: "ULFO", ...signing.dmg },
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "MpVFX",
        authors: "MpVFX",
        description: "Media-first nonlinear video editor",
        ...signing.squirrel,
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
