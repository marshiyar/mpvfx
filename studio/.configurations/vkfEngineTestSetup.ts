// Every test process evaluates keyframes with the real C++ engine, exactly as
// the app does. Build it first with `npm run build:engine`.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createModuleEngine, installVkfEngine, type VkfNativeModule } from "../shared/engine/vkfEngine";

// Absolute path supplied by the Vitest config: import.meta.url is not a file
// URL under every DOM test environment.
const modulePath = process.env.VKF_ENGINE_MODULE ?? "";
if (!modulePath || !existsSync(modulePath)) {
  throw new Error(`video-keyframing engine module missing at ${modulePath}; run \`npm run build:engine\``);
}
installVkfEngine(createModuleEngine(createRequire(modulePath)(modulePath) as VkfNativeModule));
