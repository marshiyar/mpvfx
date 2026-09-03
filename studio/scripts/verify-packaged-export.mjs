#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const appPath = resolve(
  process.argv[2] ?? "out/MpVFX-darwin-arm64/MpVFX.app",
);
const executable = join(appPath, "Contents", "MacOS", "MpVFX");
const bundledModules = join(
  appPath,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
);
const ffmpeg = join(bundledModules, "ffmpeg-static", "ffmpeg");
const ffprobe = join(
  bundledModules,
  "@ffprobe-installer",
  "darwin-arm64",
  "ffprobe",
);

for (const required of [executable, ffmpeg, ffprobe]) {
  if (!existsSync(required)) throw new Error(`Packaged export prerequisite is missing: ${required}`);
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} failed (${result.status ?? result.signal ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
};

const runtimeRoot = mkdtempSync(join(tmpdir(), "mpvfx-packaged-export-"));
const projectDir = join(runtimeRoot, "projects", "MpVFX");
const sourcePath = join(projectDir, "smoke-source.mp4");
const verificationDir = resolve("out", "verification");
mkdirSync(projectDir, { recursive: true });
mkdirSync(verificationDir, { recursive: true });

// A real H.264/AAC source with a visible border makes this exercise video,
// audio, scaling, and every edge of the output frame rather than accepting an
// empty container as a successful export.
run(ffmpeg, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=24:duration=1.25",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=523.25:sample_rate=48000:duration=1.25",
  "-vf",
  "drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=6",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  sourcePath,
]);

writeFileSync(
  join(projectDir, "index.html"),
  `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Packaged export smoke test</title></head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1.25" data-width="320" data-height="180">
      <video id="clip" class="clip" src="smoke-source.mp4" data-start="0" data-duration="1.25" data-track-index="0" data-has-audio="true" playsinline style="position:absolute;left:0px;top:0px;width:320px;height:180px;object-fit:contain;z-index:1"></video>
    </div>
  </body>
</html>`,
  "utf8",
);

let application;
try {
  application = spawn(executable, [], {
    env: {
      ...process.env,
      // Poison inherited overrides deliberately. Desktop startup must replace
      // these with paths underneath this exact app bundle.
      HYPERFRAMES_FFMPEG_PATH: "/definitely/not/a/bundled/ffmpeg",
      HYPERFRAMES_FFPROBE_PATH: "/definitely/not/a/bundled/ffprobe",
      MPVFX_BUNDLED_MEDIA_ROOT: "/definitely/not/a/bundle",
      MPVFX_USER_DATA_DIR: runtimeRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let startupLog = "";
  const origin = await new Promise((resolveOrigin, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`MpVFX did not start its editor server.\n${startupLog}`)),
      30_000,
    );
    const collect = (chunk) => {
      startupLog += chunk.toString();
      const match = startupLog.match(/Editor listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolveOrigin(match[1]);
      }
    };
    application.stdout.on("data", collect);
    application.stderr.on("data", collect);
    application.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `MpVFX exited before export verification (${code ?? signal ?? "unknown"}).\n${startupLog}`,
        ),
      );
    });
  });

  const health = await fetch(`${origin}/api/environment/ffmpeg`);
  const healthBody = await health.text();
  if (!health.ok || healthBody !== '{"ok":true}') {
    throw new Error(`Bundled media health check failed (${health.status}): ${healthBody}`);
  }

  const start = await fetch(`${origin}/api/projects/MpVFX/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "mp4",
      fps: 30,
      quality: "standard",
      dimensions: { width: 400, height: 400 },
      telemetryOptOut: true,
    }),
  });
  const startBody = await start.text();
  if (!start.ok) throw new Error(`Packaged render request failed (${start.status}): ${startBody}`);
  const { jobId } = JSON.parse(startBody);
  if (typeof jobId !== "string" || !jobId) throw new Error(`Render returned no job id: ${startBody}`);

  const progress = await fetch(`${origin}/api/render/${encodeURIComponent(jobId)}/progress`);
  const progressBody = await progress.text();
  if (!progress.ok) {
    throw new Error(`Render progress failed (${progress.status}): ${progressBody}`);
  }
  const states = [...progressBody.matchAll(/^data:(.*)$/gm)].map((match) =>
    JSON.parse(match[1].trim()),
  );
  const finalState = states.at(-1);
  if (finalState?.status !== "complete" || finalState?.progress !== 100) {
    throw new Error(`Packaged export did not complete: ${JSON.stringify(finalState ?? progressBody)}`);
  }

  const renderedPath = join(runtimeRoot, "renders", `${jobId}.mp4`);
  if (!existsSync(renderedPath) || readFileSync(renderedPath).byteLength === 0) {
    throw new Error(`Completed export has no output file: ${renderedPath}`);
  }
  const outputPath = join(verificationDir, `${jobId}.mp4`);
  const framePath = join(verificationDir, `${jobId}-frame.png`);
  copyFileSync(renderedPath, outputPath);

  const probe = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
      "-of",
      "json",
      outputPath,
    ]),
  );
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (
    video?.codec_name !== "h264" ||
    video?.width !== 400 ||
    video?.height !== 400 ||
    video?.avg_frame_rate !== "30/1"
  ) {
    throw new Error(`Unexpected exported video stream: ${JSON.stringify(video)}`);
  }
  if (audio?.codec_name !== "aac" || audio?.sample_rate !== "48000" || audio?.channels !== 2) {
    throw new Error(`Unexpected exported audio stream: ${JSON.stringify(audio)}`);
  }

  run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    "0.6",
    "-i",
    outputPath,
    "-frames:v",
    "1",
    framePath,
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        appPath,
        binaryPolicy: "bundled-only",
        jobId,
        outputPath,
        framePath,
        duration: Number(probe.format?.duration),
        video,
        audio,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (application && application.exitCode == null && application.signalCode == null) {
    application.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => application.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (application.exitCode == null && application.signalCode == null) application.kill("SIGKILL");
  }
  rmSync(runtimeRoot, { recursive: true, force: true });
}
