import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  audioGainToFaderPosition,
  audioGainToText,
  formatAudioGain,
} from "@hyperframes/core/audio-gain";
import { readAudioGroupVolume } from "@hyperframes/core/audio-groups";
import type { DomEditSelection } from "../canvas/domEditingTypes";
import { FlatSlider } from "./propertyPanelFlatPrimitives";

interface AudioGroupVolumeProps {
  element: DomEditSelection;
  onSetAttributeQuiet: (attr: string, value: string | null) => void | Promise<void>;
  onSetAttributeLive: (attr: string, value: string | null) => void | Promise<void>;
}

/** The selected bus is the sole source of truth; the slider only owns its drag draft. */
export function AudioGroupVolume({ element, onSetAttributeQuiet, onSetAttributeLive }: AudioGroupVolumeProps) {
  const volume = Math.max(0, Math.min(10 ** (12 / 20), readAudioGroupVolume(element.element)));
  const fader = audioGainToFaderPosition(volume);
  return (
    <div className="mb-3 border-b border-panel-hairline pb-3">
      <FlatSlider
        label="Group volume"
        value={fader}
        min={AUDIO_GAIN_FADER_MIN}
        max={AUDIO_GAIN_FADER_MAX}
        tier={volume === 1 ? "default" : "explicitCustom"}
        displayValue={audioGainToText(volume)}
        formatValue={(next) => audioGainToText(audioFaderPositionToGain(next))}
        centerTick
        onReset={() => void onSetAttributeQuiet("data-volume", null)}
        onPreview={(next) => void onSetAttributeLive("data-volume", formatAudioGain(audioFaderPositionToGain(next)))}
        onCommit={(next) => void onSetAttributeQuiet("data-volume", formatAudioGain(audioFaderPositionToGain(next)))}
      />
    </div>
  );
}
