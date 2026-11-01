import {
  BOT_BODIES,
  BOT_COLOURS,
  BOT_FACES,
  BOT_GAITS,
  BOT_SHAPES,
  BOT_TOPPERS,
  type BotAppearance,
  type BotShape,
} from "@jj/contracts";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { PixelSprite, spritePaths } from "../../components/sprite";
import { SHAPES } from "../../components/sprite/parts";
import { rovingTabStop, rovingTarget } from "../../components/ui/roving";
import {
  APPEARANCE_PRESETS,
  BODY_LABELS,
  COLOUR_LABELS,
  FACE_LABELS,
  GAIT_LABELS,
  GAIT_NOTES,
  SHAPE_LABELS,
  TOPPER_LABELS,
  TOPPER_NOTES,
} from "../../lib/appearance";
import { COLOUR_RAMPS } from "../../lib/colour";
import { type AppearancePart, matchingPreset } from "./studioDraft";

/** Every sprite character drawn in the chip's text colour. */
const INK_PALETTE = {
  b: "currentColor",
  d: "currentColor",
  l: "currentColor",
  k: "currentColor",
  w: "currentColor",
  g: "currentColor",
  y: "currentColor",
  e: "currentColor",
  s: "currentColor",
} as const;

/** The 14px shape silhouette in a SHAPE chip: the shape's main layer only. */
function ShapeIcon({ shape }: { shape: BotShape }) {
  const main = SHAPES[shape].map((row) => row.replace(/[^b]/g, "."));
  const [path] = spritePaths(main, INK_PALETTE);
  return (
    <svg
      className="studio-shape-icon"
      viewBox="0 0 12 12"
      width={14}
      height={14}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {path && <path fill="currentColor" d={path.d} />}
    </svg>
  );
}

/** What a radio item needs from its group: its checked state and roving focus. */
interface RadioItemProps {
  role: "radio";
  "aria-checked": boolean;
  tabIndex: 0 | -1;
  ref: (element: HTMLButtonElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}

/**
 * One part as a radio group (the kit Segmented pattern): a single Tab stop,
 * arrows move to and pick the neighbouring option (wrapping), Home and End
 * jump to the ends. `checked` may be null (no preset matches): the first
 * option is then the Tab stop.
 */
function PartGroup<Value extends string>({
  label,
  note,
  options,
  checked,
  onPick,
  renderOption,
  layout = "chips",
}: {
  label: string;
  note?: string;
  options: readonly Value[];
  checked: Value | null;
  onPick: (value: Value) => void;
  renderOption: (value: Value, item: RadioItemProps) => ReactNode;
  /** `chips` and `swatches` wrap (gap 6 / 8); `presets` is the 4-column grid. */
  layout?: "chips" | "swatches" | "presets";
}) {
  const id = useId();
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = options.map(() => false);
  const tabStop = rovingTabStop(
    disabled,
    checked === null ? -1 : options.indexOf(checked),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const target = rovingTarget(disabled, from, event.key, "both");
    const value = target === null ? undefined : options[target];
    if (target === null || value === undefined) return;
    event.preventDefault();
    items.current[target]?.focus();
    if (value !== checked) onPick(value);
  };
  return (
    <div className="studio-part">
      <div className="studio-part__head">
        <span id={id}>{label}</span>
        {note && <span className="studio-part__note">{note}</span>}
      </div>
      <div
        className={`studio-part__items studio-part__items--${layout}`}
        role="radiogroup"
        aria-labelledby={id}
      >
        {options.map((value, index) =>
          renderOption(value, {
            role: "radio",
            "aria-checked": value === checked,
            tabIndex: index === tabStop ? 0 : -1,
            ref: (element) => {
              items.current[index] = element;
            },
            onKeyDown: (event) => onKeyDown(event, index),
            onClick: () => {
              if (value !== checked) onPick(value);
            },
          }),
        )}
      </div>
    </div>
  );
}

/** A chip-styled radio (SPEC §11 chips), checked look on `aria-checked`. */
function ChipRadio({
  item,
  leading,
  children,
}: {
  item: RadioItemProps;
  leading?: ReactNode;
  children: ReactNode;
}) {
  const { ref, ...rest } = item;
  return (
    <button ref={ref} type="button" className="ui-chip studio-chip" {...rest}>
      {leading}
      {children}
    </button>
  );
}

export interface PartPickersProps {
  appearance: BotAppearance;
  onPart: <Part extends AppearancePart>(
    part: Part,
    value: BotAppearance[Part],
  ) => void;
  onPreset: (appearance: BotAppearance) => void;
}

/** The right column of Bot Studio (SPEC §11): one group per part, then presets. */
export function PartPickers({
  appearance,
  onPart,
  onPreset,
}: PartPickersProps) {
  const preset = matchingPreset(appearance);
  return (
    <section aria-label="Parts" className="studio-parts">
      <PartGroup
        label="Shape"
        options={BOT_SHAPES}
        checked={appearance.shape}
        onPick={(shape) => onPart("shape", shape)}
        renderOption={(shape, item) => (
          <ChipRadio
            key={shape}
            item={item}
            leading={<ShapeIcon shape={shape} />}
          >
            {SHAPE_LABELS[shape]}
          </ChipRadio>
        )}
      />
      <PartGroup
        label="Face"
        options={BOT_FACES}
        checked={appearance.face}
        onPick={(face) => onPart("face", face)}
        renderOption={(face, item) => (
          <ChipRadio key={face} item={item}>
            {FACE_LABELS[face]}
          </ChipRadio>
        )}
      />
      <PartGroup
        label="Topper"
        note={TOPPER_NOTES[appearance.topper]}
        options={BOT_TOPPERS}
        checked={appearance.topper}
        onPick={(topper) => onPart("topper", topper)}
        renderOption={(topper, item) => (
          <ChipRadio key={topper} item={item}>
            {TOPPER_LABELS[topper]}
          </ChipRadio>
        )}
      />
      <PartGroup
        label="Colour"
        note={COLOUR_LABELS[appearance.colour]}
        layout="swatches"
        options={BOT_COLOURS}
        checked={appearance.colour}
        onPick={(colour) => onPart("colour", colour)}
        renderOption={(colour, { ref, ...item }) => (
          <button
            key={colour}
            ref={ref}
            type="button"
            className="studio-swatch"
            style={{ background: COLOUR_RAMPS[colour].f }}
            aria-label={COLOUR_LABELS[colour]}
            {...item}
          />
        )}
      />
      <PartGroup
        label="Body"
        options={BOT_BODIES}
        checked={appearance.body}
        onPick={(body) => onPart("body", body)}
        renderOption={(body, item) => (
          <ChipRadio key={body} item={item}>
            {BODY_LABELS[body]}
          </ChipRadio>
        )}
      />
      <PartGroup
        label="Walk"
        note={GAIT_NOTES[appearance.gait]}
        options={BOT_GAITS}
        checked={appearance.gait}
        onPick={(gait) => onPart("gait", gait)}
        renderOption={(gait, item) => (
          <ChipRadio key={gait} item={item}>
            {GAIT_LABELS[gait]}
          </ChipRadio>
        )}
      />
      <PartGroup
        label="Start from"
        note={preset ? preset.name : "Custom"}
        layout="presets"
        options={PRESET_NAMES}
        checked={preset?.name ?? null}
        onPick={(name) => {
          const picked = APPEARANCE_PRESETS.find((item) => item.name === name);
          if (picked) onPreset(picked.appearance);
        }}
        renderOption={(name, { ref, ...item }) => {
          const look = APPEARANCE_PRESETS.find((p) => p.name === name);
          return (
            <button
              key={name}
              ref={ref}
              type="button"
              className="studio-preset"
              {...item}
            >
              {look && <PixelSprite appearance={look.appearance} size={36} />}
              <span className="studio-preset__name">{name}</span>
            </button>
          );
        }}
      />
    </section>
  );
}

const PRESET_NAMES: readonly string[] = APPEARANCE_PRESETS.map(
  (item) => item.name,
);
