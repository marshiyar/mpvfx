import { createBridgeEngine, installVkfEngine, type VkfEngineBridge } from "../../shared/engine/vkfEngine";

declare global {
  interface Window { vkfEngine?: VkfEngineBridge }
}

/** Connect the editor to the C++ engine exposed by the desktop preload. */
export function installDesktopVkfEngine(): void {
  if (!window.vkfEngine) {
    throw new Error("The video-keyframing engine is unavailable: start MpVFX through its desktop app");
  }
  installVkfEngine(createBridgeEngine(window.vkfEngine));
}
