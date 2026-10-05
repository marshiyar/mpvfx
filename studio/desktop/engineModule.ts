import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createModuleEngine, installVkfEngine, type VkfNativeModule } from "../shared/engine/vkfEngine";

/** Where the C++ engine module lives: packaged as a resource, or the local build. */
export function resolveEngineModulePath(options: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  const path = options.isPackaged
    ? join(options.resourcesPath, "vkf.node")
    : join(options.appPath, ".build", "native", "vkf", "vkf.node");
  if (!existsSync(path)) {
    throw new Error(`The video-keyframing engine is missing (${path}). Run \`npm run build:engine\`.`);
  }
  return path;
}

export function loadEngineModule(path: string): VkfNativeModule {
  return createRequire(import.meta.url)(path) as VkfNativeModule;
}

export function installEngineInMainProcess(path: string): void {
  installVkfEngine(createModuleEngine(loadEngineModule(path)));
}
