// Bundle entry for export capture pages: exposes the installer only.
import { installNativeExportFrameRuntime } from "./nativeExportFrameRuntime";

(window as Window & { __studioInstallNativeExportFrameRuntime?: typeof installNativeExportFrameRuntime })
  .__studioInstallNativeExportFrameRuntime = installNativeExportFrameRuntime;
