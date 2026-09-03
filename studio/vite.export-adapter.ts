import type { CanvasResolution } from "@hyperframes/parsers";
import type { Fps } from "@hyperframes/core";
import type { EngineConfig } from "@hyperframes/engine";
import type { ExportFormat, ExportQuality } from "./src/utils/exportPolicy";

export interface StandaloneProducerRenderInput {
  fps: Fps;
  quality: ExportQuality;
  format: ExportFormat;
  outputResolution?: CanvasResolution;
  composition?: string;
  variables?: Record<string, unknown>;
  renderBodyScripts?: string[];
}

export interface StandaloneProducerRenderConfig {
  fps: Fps;
  quality: ExportQuality;
  format: ExportFormat;
  useGpu?: boolean;
  outputResolution?: CanvasResolution;
  entryFile?: string;
  variables?: Record<string, unknown>;
  renderBodyScripts?: string[];
  /** Trusted, fully resolved local-render profile; never copied from an HTTP request. */
  producerConfig?: EngineConfig;
}

export function buildStandaloneProducerRenderConfig(
  input: StandaloneProducerRenderInput,
): StandaloneProducerRenderConfig {
  return {
    fps: input.fps,
    quality: input.quality,
    format: input.format,
    // The engine probes the encoder with a real one-frame encode and falls
    // back to software when no compatible accelerator is usable. Studio owns
    // this policy so users do not need to know about VideoToolbox or codecs.
    ...(input.format === "mp4" ? { useGpu: true } : {}),
    ...(input.format === "mp4" && input.outputResolution
      ? { outputResolution: input.outputResolution }
      : {}),
    ...(input.composition ? { entryFile: input.composition } : {}),
    ...(input.variables ? { variables: input.variables } : {}),
    ...(input.renderBodyScripts && input.renderBodyScripts.length > 0
      ? { renderBodyScripts: input.renderBodyScripts }
      : {}),
  };
}
