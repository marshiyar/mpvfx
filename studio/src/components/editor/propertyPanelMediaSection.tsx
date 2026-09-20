import { useState } from "react";
import { Check, ClipboardList, Film, Music } from "../../icons/SystemIcons";
import type { DomEditSelection } from "./domEditing";
import {
  formatNumericValue,
  formatTimingValue,
  LABEL,
  parseNumericValue,
  RESPONSIVE_GRID,
} from "./propertyPanelHelpers";
import { Section, SegmentedControl, SelectField, SliderControl } from "./propertyPanelPrimitives";
import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  formatAudioGain,
  audioGainToFaderPosition,
  audioGainToText,
} from "@hyperframes/core/audio-gain";

// fallow-ignore-next-line complexity
export function MediaSection({
  projectDir,
  element,
  styles,
  onSetStyle,
  onSetAttribute,
  onSetHtmlAttribute,
}: {
  projectDir: string | null;
  element: DomEditSelection;
  styles: Record<string, string>;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  onSetHtmlAttribute: (attr: string, value: string | null) => void | Promise<void>;
}) {
  const track = useTrackDesignInput();
  const isVideo = element.tagName === "video";
  const isAudio = element.tagName === "audio";
  const isImage = element.tagName === "img";
  const isVisualMedia = isVideo || isImage;
  const el = element.element;

  const volume = parseNumericValue(element.dataAttributes.volume ?? "") ?? 1;
  const volumeFaderPosition = audioGainToFaderPosition(volume);

  const mediaStart =
    Number.parseFloat(
      element.dataAttributes["media-start"] ?? element.dataAttributes["playback-start"] ?? "0",
    ) || 0;

  const hasLoop = el.hasAttribute("loop");
  const hasMuted = el.hasAttribute("muted");
  const hasAudio = element.dataAttributes["has-audio"] === "true";

  const playbackRate = Number.parseFloat(element.dataAttributes["playback-rate"] ?? "1") || 1;

  const objectFit = styles["object-fit"] || "contain";
  const objectPosition = styles["object-position"] || "center";

  const sourceDuration =
    Number.parseFloat(element.dataAttributes["source-duration"] ?? "") ||
    (el as HTMLMediaElement).duration ||
    0;
  const mediaStartMax = Math.max(30, Math.ceil(sourceDuration || mediaStart + 10));

  const srcAttr = el.getAttribute("src") ?? "";
  const [copied, setCopied] = useState(false);

  const absoluteSrc =
    projectDir && srcAttr && !srcAttr.startsWith("http") ? `${projectDir}/${srcAttr}` : srcAttr;
  const panelTitle = isImage ? "Image" : isVideo ? "Video" : "Audio";

  return (
    <Section title={panelTitle} icon={isAudio ? <Music size={15} /> : <Film size={15} />}>
      <div className="space-y-4">
        {srcAttr && (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium text-neutral-500">Source</div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(absoluteSrc).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="flex h-6 items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-950 px-2 text-[10px] font-medium text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
              >
                {copied ? <Check size={11} /> : <ClipboardList size={11} />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div
              className="mt-1 truncate text-[11px] font-medium text-neutral-300"
              title={absoluteSrc}
            >
              {absoluteSrc}
            </div>
          </div>
        )}

        {(isVideo || isAudio) && (
          <>
            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>Volume</span>
              <SliderControl
                trackName="Volume"
                value={volumeFaderPosition}
                min={AUDIO_GAIN_FADER_MIN}
                max={AUDIO_GAIN_FADER_MAX}
                step={1}
                displayValue={audioGainToText(volume)}
                formatDisplayValue={(next) => audioGainToText(audioFaderPositionToGain(next))}
                onReset={() => void onSetAttribute("volume", "1")}
                onCommit={(next) => {
                  void onSetAttribute("volume", formatAudioGain(audioFaderPositionToGain(next)));
                }}
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>Playback rate</span>
              <SliderControl
                trackName="Playback rate"
                value={playbackRate * 100}
                min={25}
                max={300}
                step={5}
                displayValue={`${formatNumericValue(playbackRate)}x`}
                formatDisplayValue={(next) => `${formatNumericValue(next / 100)}x`}
                onReset={() => void onSetAttribute("playback-rate", "1")}
                onCommit={(next) => {
                  void onSetAttribute("playback-rate", formatNumericValue(next / 100));
                }}
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>Media start</span>
              <SliderControl
                trackName="Media start"
                value={Math.round(mediaStart * 100)}
                min={0}
                max={mediaStartMax * 100}
                step={10}
                displayValue={formatTimingValue(mediaStart)}
                formatDisplayValue={(next) => formatTimingValue(next / 100)}
                onReset={() => void onSetAttribute("media-start", "0.00")}
                onCommit={(next) => {
                  void onSetAttribute("media-start", (next / 100).toFixed(2));
                }}
              />
            </div>

            <div className={RESPONSIVE_GRID}>
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>Loop</span>
                <SegmentedControl
                  trackName="Loop"
                  value={hasLoop ? "on" : "off"}
                  onChange={(next) => {
                    void onSetHtmlAttribute("loop", next === "on" ? "true" : null);
                  }}
                  options={[
                    { label: "On", value: "on" },
                    { label: "Off", value: "off" },
                  ]}
                />
              </div>
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>Muted</span>
                <SegmentedControl
                  trackName="Muted"
                  value={hasMuted ? "on" : "off"}
                  onChange={(next) => {
                    void onSetHtmlAttribute("muted", next === "on" ? "true" : null);
                  }}
                  options={[
                    { label: "On", value: "on" },
                    { label: "Off", value: "off" },
                  ]}
                />
              </div>
            </div>

            {isVideo && (
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>Has audio track</span>
                <SegmentedControl
                  trackName="Has audio track"
                  value={hasAudio ? "yes" : "no"}
                  onChange={(next) => {
                    if (next === "yes") {
                      void onSetAttribute("has-audio", "true");
                      void onSetHtmlAttribute("muted", null);
                    } else {
                      void onSetAttribute("has-audio", "");
                      void onSetHtmlAttribute("muted", "true");
                    }
                  }}
                  options={[
                    { label: "Yes", value: "yes" },
                    { label: "No", value: "no" },
                  ]}
                />
              </div>
            )}
          </>
        )}

        {isVisualMedia && (
          <>
            <div className={RESPONSIVE_GRID}>
              <SelectField
                label="Fit"
                value={objectFit}
                onChange={(next) => {
                  void onSetStyle("object-fit", next);
                }}
                options={["contain", "cover", "fill", "none", "scale-down"]}
              />
              <SelectField
                label="Position"
                value={objectPosition}
                onChange={(next) => {
                  void onSetStyle("object-position", next);
                }}
                options={[
                  "center",
                  "top",
                  "bottom",
                  "left",
                  "right",
                  "left top",
                  "right top",
                  "left bottom",
                  "right bottom",
                ]}
              />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
