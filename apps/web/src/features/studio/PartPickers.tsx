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
import { type ReactNode, useId } from "react";
import { PixelSprite, spritePaths } from "../../components/sprite";
import { SHAPES } from "../../components/sprite/parts";
import { Chip } from "../../components/ui";
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
import {
  type AppearancePart,
  matchingPreset,
  sameAppearance,
} from "./studioDraft";

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

function PartGroup({
  label,
  note,
  children,
  layout = "chips",
}: {
  label: string;
  note?: string;
  children: ReactNode;
  /** `chips` and `swatches` wrap (gap 6 / 8); `presets` is the 4-column grid. */
  layout?: "chips" | "swatches" | "presets";
}) {
  const id = useId();
  return (
    <div className="studio-part" role="group" aria-labelledby={id}>
      <div className="studio-part__head">
        <span id={id}>{label}</span>
        {note && <span className="studio-part__note">{note}</span>}
      </div>
      <div className={`studio-part__items studio-part__items--${layout}`}>
        {children}
      </div>
    </div>
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
      <PartGroup label="Shape">
        {BOT_SHAPES.map((shape) => (
          <Chip
            key={shape}
            selected={appearance.shape === shape}
            leading={<ShapeIcon shape={shape} />}
            onClick={() => onPart("shape", shape)}
          >
            {SHAPE_LABELS[shape]}
          </Chip>
        ))}
      </PartGroup>
      <PartGroup label="Face">
        {BOT_FACES.map((face) => (
          <Chip
            key={face}
            selected={appearance.face === face}
            onClick={() => onPart("face", face)}
          >
            {FACE_LABELS[face]}
          </Chip>
        ))}
      </PartGroup>
      <PartGroup label="Topper" note={TOPPER_NOTES[appearance.topper]}>
        {BOT_TOPPERS.map((topper) => (
          <Chip
            key={topper}
            selected={appearance.topper === topper}
            onClick={() => onPart("topper", topper)}
          >
            {TOPPER_LABELS[topper]}
          </Chip>
        ))}
      </PartGroup>
      <PartGroup
        label="Colour"
        note={COLOUR_LABELS[appearance.colour]}
        layout="swatches"
      >
        {BOT_COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            className="studio-swatch"
            style={{ background: COLOUR_RAMPS[colour].f }}
            aria-label={COLOUR_LABELS[colour]}
            title={COLOUR_LABELS[colour]}
            aria-pressed={appearance.colour === colour}
            onClick={() => onPart("colour", colour)}
          />
        ))}
      </PartGroup>
      <PartGroup label="Body">
        {BOT_BODIES.map((body) => (
          <Chip
            key={body}
            selected={appearance.body === body}
            onClick={() => onPart("body", body)}
          >
            {BODY_LABELS[body]}
          </Chip>
        ))}
      </PartGroup>
      <PartGroup label="Walk" note={GAIT_NOTES[appearance.gait]}>
        {BOT_GAITS.map((gait) => (
          <Chip
            key={gait}
            selected={appearance.gait === gait}
            onClick={() => onPart("gait", gait)}
          >
            {GAIT_LABELS[gait]}
          </Chip>
        ))}
      </PartGroup>
      <PartGroup
        label="Start from"
        note={preset ? preset.name : "Custom"}
        layout="presets"
      >
        {APPEARANCE_PRESETS.map((item) => (
          <button
            key={item.name}
            type="button"
            className="studio-preset"
            aria-pressed={sameAppearance(item.appearance, appearance)}
            onClick={() => onPreset(item.appearance)}
          >
            <PixelSprite appearance={item.appearance} size={36} />
            <span className="studio-preset__name">{item.name}</span>
          </button>
        ))}
      </PartGroup>
    </section>
  );
}
