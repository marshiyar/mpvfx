import { useCallback, useEffect, useState } from "react";
import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import { Plus, RotateCcw, X } from "../../icons/SystemIcons";
import { isTextEditableSelection, type DomEditSelection } from "./domEditing";
import type { ImportedFontAsset } from "./fontAssets";
import { normalizeTextMetricValue } from "./propertyPanelHelpers";
import { ColorField } from "./propertyPanelColor";
import { FontFamilyField } from "./propertyPanelFont";
import { FlatRow, FlatSegmentedRow } from "./propertyPanelFlatPrimitives";
import {
  resolveValueTier,
  VALUE_TIER_LABEL_CLASS,
  VALUE_TIER_VALUE_CLASS,
} from "./propertyPanelValueTier";
import {
  detectAvailableWeights,
  formatTextFieldPreview,
  getTextFieldColor,
  getTextStyleValue,
  TextAreaField,
  WEIGHT_LABELS,
} from "./propertyPanelSections";

/* ------------------------------------------------------------------ */
/*  Flat text section (design_handoff_studio_inspector, #10a)          */
/* ------------------------------------------------------------------ */

const ALIGN_OPTIONS = [
  { key: "left", label: "left", node: "L" },
  { key: "center", label: "center", node: "C" },
  { key: "right", label: "right", node: "R" },
  { key: "justify", label: "justify", node: "J" },
];

const CASE_OPTIONS = [
  { key: "none", label: "none", node: "–" },
  { key: "uppercase", label: "uppercase", node: "AG" },
  { key: "lowercase", label: "lowercase", node: "ag" },
  { key: "capitalize", label: "capitalize", node: "Ag" },
];

function FlatTextFieldEditor({
  field,
  styles,
  fontAssets,
  onImportFonts,
  onSetText,
  onSetTextFieldStyle,
  onPreviewTextFieldStyle,
  autoFocus = false,
}: {
  field: DomEditSelection["textFields"][number];
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onPreviewTextFieldStyle?: (fieldKey: string, property: string, value: string) => void;
  autoFocus?: boolean;
}) {
  const track = useTrackDesignInput();
  const weight = getTextStyleValue(field, styles, "font-weight", "400");
  const weightOptions = detectAvailableWeights(
    field.computedStyles["font-family"] || styles["font-family"] || "",
  );
  const align = getTextStyleValue(field, styles, "text-align", "start");
  const textTransform = getTextStyleValue(field, styles, "text-transform", "none");
  const fontStyle = getTextStyleValue(field, styles, "font-style", "normal");
  const fontFamilyTier = resolveValueTier(
    field.inlineStyles["font-family"],
    styles["font-family"] || "inherit",
  );
  const weightTier = resolveValueTier(field.inlineStyles["font-weight"], "400");
  const alignTier = resolveValueTier(field.inlineStyles["text-align"], "start");
  const textTransformTier = resolveValueTier(field.inlineStyles["text-transform"], "none");
  const fontStyleTier = resolveValueTier(field.inlineStyles["font-style"], "normal");
  const caseStyleIsCustom =
    textTransformTier === "explicitCustom" || fontStyleTier === "explicitCustom";
  const colorTier = resolveValueTier(
    field.inlineStyles.color,
    styles.color || "rgb(0, 0, 0)",
  );
  const resetTextColor = useCallback(
    () => onSetTextFieldStyle(field.key, "color", ""),
    [field.key, onSetTextFieldStyle],
  );

  return (
    <>
      <TextAreaField
        flat
        label="Content"
        value={field.value}
        autoFocus={autoFocus}
        onCommit={(next) => onSetText(next, field.key)}
      />
      <div className="group flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <FontFamilyField
            flat
            value={field.computedStyles["font-family"] || styles["font-family"] || "inherit"}
            importedFonts={fontAssets}
            onImportFonts={onImportFonts}
            onCommit={(next) => onSetTextFieldStyle(field.key, "font-family", next)}
          />
        </div>
        {fontFamilyTier === "explicitCustom" && (
          <button
            type="button"
            data-flat-text-font-reset="true"
            title="Remove font — fall back to default"
            onClick={() => {
              track("button", "Reset Font");
              onSetTextFieldStyle(field.key, "font-family", "");
            }}
            className="flex-shrink-0 text-panel-text-3 opacity-0 transition-opacity hover:text-panel-text-1 group-hover:opacity-100"
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      <FlatRow
        label="Size"
        value={field.computedStyles["font-size"] || styles["font-size"] || "16px"}
        tier={resolveValueTier(field.inlineStyles["font-size"], styles["font-size"] || "16px")}
        liveCommit
        onPreview={(next) => onPreviewTextFieldStyle?.(field.key, "font-size", next)}
        onCommit={(next) => onSetTextFieldStyle(field.key, "font-size", next)}
        onReset={() => onSetTextFieldStyle(field.key, "font-size", "")}
      />
      <div className="group flex min-h-[30px] items-center justify-between">
        <span
          className={
            VALUE_TIER_LABEL_CLASS[weightTier]
          }
          style={{ fontSize: 11 }}
        >
          Weight
        </span>
        <span className="flex items-center gap-1.5">
          <label className="flex items-center gap-1.5 border-b border-panel-border-input/50 pb-px hover:border-panel-border-input">
            <select
              value={weight}
              onChange={(e) => {
                track("select", "Weight");
                onSetTextFieldStyle(field.key, "font-weight", e.target.value);
              }}
              className={`appearance-none bg-transparent text-right font-mono text-[11px] outline-none ${VALUE_TIER_VALUE_CLASS[weightTier]}`}
            >
              {(weightOptions.includes(weight) ? weightOptions : [weight, ...weightOptions]).map(
                (option) => (
                  <option key={option} value={option}>
                    {WEIGHT_LABELS[option] ?? option}
                  </option>
                ),
              )}
            </select>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
              className="flex-shrink-0 text-panel-text-5"
            >
              <path d="M2 3l3 4 3-4z" />
            </svg>
          </label>
          {weightTier === "explicitCustom" && (
            <button
              type="button"
              data-flat-text-weight-reset="true"
              title="Remove weight — fall back to default"
              onClick={() => {
                track("button", "Reset Weight");
                onSetTextFieldStyle(field.key, "font-weight", "");
              }}
              className="flex-shrink-0 text-panel-text-3 opacity-0 transition-opacity hover:text-panel-text-1 group-hover:opacity-100"
            >
              <RotateCcw size={11} />
            </button>
          )}
        </span>
      </div>
      <FlatRow
        label="Letter spacing"
        value={getTextStyleValue(field, styles, "letter-spacing", "0px")}
        tier={resolveValueTier(field.inlineStyles["letter-spacing"], "0px")}
        onCommit={(next) =>
          onSetTextFieldStyle(
            field.key,
            "letter-spacing",
            normalizeTextMetricValue("letter-spacing", next),
          )
        }
        onReset={() => onSetTextFieldStyle(field.key, "letter-spacing", "")}
      />
      <FlatRow
        label="Line height"
        value={getTextStyleValue(field, styles, "line-height", "normal")}
        tier={resolveValueTier(field.inlineStyles["line-height"], "normal")}
        onCommit={(next) =>
          onSetTextFieldStyle(
            field.key,
            "line-height",
            normalizeTextMetricValue("line-height", next),
          )
        }
        onReset={() => onSetTextFieldStyle(field.key, "line-height", "")}
      />
      <FlatSegmentedRow
        label="Align"
        tier={alignTier === "explicitCustom" ? "explicitCustom" : "default"}
        options={ALIGN_OPTIONS.map((option) => ({
          key: option.key,
          node: option.node,
          label: option.label,
          active:
            align === option.key ||
            (option.key === "left" && align === "start") ||
            (option.key === "right" && align === "end"),
        }))}
        onChange={(next) => {
          // Re-clicking the option that's already visually active for a
          // logical value (authored "start"/"end") must not rewrite it to
          // the physical "left"/"right" — that destroys the logical
          // semantics and is wrong for RTL content. Only write when the
          // user actually picked a different alignment.
          if ((next === "left" && align === "start") || (next === "right" && align === "end")) {
            return;
          }
          onSetTextFieldStyle(field.key, "text-align", next);
        }}
        onReset={() => onSetTextFieldStyle(field.key, "text-align", "")}
      />
      <FlatSegmentedRow
        label="Case · Style"
        tier={caseStyleIsCustom ? "explicitCustom" : "default"}
        options={[
          ...CASE_OPTIONS.map((option) => ({
            key: option.key,
            node: option.node,
            label: option.label,
            active: textTransform === option.key,
          })),
          { key: "normal", node: "A", label: "upright", active: fontStyle === "normal" },
          { key: "italic", node: "A", label: "italic", active: fontStyle === "italic" },
        ]}
        spacerAfterIndex={2}
        onChange={(next) => {
          if (next === "normal" || next === "italic") {
            onSetTextFieldStyle(field.key, "font-style", next);
          } else {
            onSetTextFieldStyle(field.key, "text-transform", next);
          }
        }}
        onReset={() => {
          if (textTransformTier === "explicitCustom") {
            onSetTextFieldStyle(field.key, "text-transform", "");
          }
          if (fontStyleTier === "explicitCustom") {
            onSetTextFieldStyle(field.key, "font-style", "");
          }
        }}
      />
      <ColorField
        flat
        label="Color"
        value={getTextFieldColor(field, styles)}
        onPreview={(next) => onPreviewTextFieldStyle?.(field.key, "color", next)}
        onCommit={(next) => onSetTextFieldStyle(field.key, "color", next)}
        onReset={colorTier === "explicitCustom" ? resetTextColor : undefined}
      />
    </>
  );
}

export function FlatTextSection({
  element,
  styles,
  fontAssets,
  onImportFonts,
  onSetText,
  onSetTextFieldStyle,
  onPreviewTextFieldStyle,
  onAddTextField,
  onRemoveTextField,
}: {
  element: DomEditSelection;
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onPreviewTextFieldStyle?: (fieldKey: string, property: string, value: string) => void;
  onAddTextField: (afterFieldKey?: string) => string | Promise<string | null> | null;
  onRemoveTextField: (fieldKey: string) => void;
}) {
  const track = useTrackDesignInput();
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(
    element.textFields[0]?.key ?? null,
  );
  // Armed by the add handler so the newly added field mounts focused. State, not
  // a ref cleared during render: Strict Mode renders twice, so the first pass
  // would eat the marker and the second would mount the field unfocused. Nothing
  // clears it on read either — `autoFocus` is a mount-only DOM prop and the
  // editor is keyed on the field, so it can only fire once per added field.
  const [autoFocusFieldKey, setAutoFocusFieldKey] = useState<string | null>(null);

  useEffect(() => {
    const nextFields = element.textFields;
    setActiveFieldKey((current) => {
      if (current && nextFields.some((field) => field.key === current)) return current;
      return nextFields[0]?.key ?? null;
    });
  }, [element.id, element.selector, element.textFields]);

  if (!isTextEditableSelection(element)) return null;
  const textFields = element.textFields;
  const activeField = textFields.find((field) => field.key === activeFieldKey) ?? textFields[0];
  if (!activeField) return null;

  const autoFocusActiveField = autoFocusFieldKey === activeField.key;

  if (textFields.length > 1) {
    return (
      <div className="space-y-2.5">
        <FlatTextLayerList
          fields={textFields}
          activeFieldKey={activeField.key}
          styles={styles}
          onSelect={(fieldKey) => {
            setAutoFocusFieldKey(null);
            setActiveFieldKey(fieldKey);
          }}
          onAdd={() =>
            void Promise.resolve(onAddTextField(activeField.key)).then((nextKey) => {
              if (!nextKey) return;
              setAutoFocusFieldKey(nextKey);
              setActiveFieldKey(nextKey);
            })
          }
          onRemove={onRemoveTextField}
        />
        <FlatTextFieldEditor
          key={activeField.key}
          field={activeField}
          styles={styles}
          fontAssets={fontAssets}
          onImportFonts={onImportFonts}
          onSetText={onSetText}
          onSetTextFieldStyle={onSetTextFieldStyle}
          onPreviewTextFieldStyle={onPreviewTextFieldStyle}
          autoFocus={autoFocusActiveField}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <FlatTextFieldEditor
        field={activeField}
        styles={styles}
        fontAssets={fontAssets}
        onImportFonts={onImportFonts}
        onSetText={onSetText}
        onSetTextFieldStyle={onSetTextFieldStyle}
        onPreviewTextFieldStyle={onPreviewTextFieldStyle}
      />
      <button
        type="button"
        onClick={() => {
          track("button", "Add text field");
          void Promise.resolve(onAddTextField(activeField.key)).then((nextKey) => {
            if (!nextKey) return;
            setAutoFocusFieldKey(nextKey);
            setActiveFieldKey(nextKey);
          });
        }}
        className="mt-0.5 flex items-center gap-[5px] text-[10px] text-panel-text-4 hover:text-panel-text-2"
      >
        <Plus size={10} />
        Add text field
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Multi-field layer list (design_handoff_studio_inspector, #10a —     */
/*  no mock exists for this row; layout originated by this plan,        */
/*  following the "left-rule nested content" convention established     */
/*  by Text's own content block, Motion's effect cards, and Media's     */
/*  cutout block. Flag for design review.)                              */
/* ------------------------------------------------------------------ */

export function FlatTextLayerList({
  fields,
  activeFieldKey,
  styles,
  onSelect,
  onAdd,
  onRemove,
}: {
  fields: DomEditSelection["textFields"];
  activeFieldKey: string;
  styles: Record<string, string>;
  onSelect: (fieldKey: string) => void;
  onAdd: () => void;
  onRemove: (fieldKey: string) => void;
}) {
  const track = useTrackDesignInput();
  return (
    <div className="mb-2 border-l-2 border-panel-border-input py-0.5 pl-[10px]">
      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-panel-text-5">
        Text layers
      </div>
      <div className="space-y-1">
        {fields.map((field, index) => {
          const active = field.key === activeFieldKey;
          return (
            <div
              key={field.key}
              data-flat-text-layer-row="true"
              data-active={active}
              onClick={() => onSelect(field.key)}
              className={`flex min-h-[26px] cursor-pointer items-center gap-2 rounded px-1 ${
                active ? "bg-panel-accent/10" : "hover:bg-panel-hover"
              }`}
            >
              <span
                className="h-3 w-3 flex-shrink-0 rounded-sm"
                style={{ backgroundColor: getTextFieldColor(field, styles) }}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-panel-text-1">
                {formatTextFieldPreview(field.value) || `Text ${index + 1}`}
              </span>
              <span className="flex-shrink-0 font-mono text-[9px] text-panel-text-4">
                {field.tagName}
              </span>
              {fields.length > 1 && (
                <button
                  type="button"
                  data-flat-text-layer-remove="true"
                  aria-label="Remove text field"
                  onClick={(e) => {
                    e.stopPropagation();
                    track("button", "Remove text field");
                    onRemove(field.key);
                  }}
                  className="flex-shrink-0 text-panel-text-4 hover:text-panel-text-1"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        data-flat-text-layer-add="true"
        onClick={() => {
          track("button", "Add text field");
          onAdd();
        }}
        className="mt-1 flex items-center gap-[5px] text-[10px] text-panel-text-4 hover:text-panel-text-2"
      >
        <Plus size={10} />
        Add text field
      </button>
    </div>
  );
}
