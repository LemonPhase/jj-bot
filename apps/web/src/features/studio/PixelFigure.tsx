import type { BotAppearance } from "@jj/contracts";
import { spritePathsFor } from "../../components/sprite";
import { TypingDots } from "../../components/ui";
import { BODY_TONES, COLOUR_RAMPS } from "../../lib/colour";

/** Preview-only motions (SPEC §11). Never persisted. */
export type PreviewMotion = "idle" | "walk" | "talk" | "work";

export interface PixelFigureProps {
  appearance: BotAppearance;
  motion: PreviewMotion;
  /** CSS px per sprite pixel. */
  cell?: number;
}

/** Neck tones from the design's 3D character (same in both themes). */
const NECK = "#8A8A94";

/** One cell-aligned rectangle. */
const Px = ({
  x,
  y,
  w = 1,
  h = 1,
  fill,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  fill: string;
}) => <rect x={x} y={y} width={w} height={h} fill={fill} />;

/**
 * The Studio stage figure (brief decision 7: the 2D pixel sprite, large, plus
 * the gait animation instead of the design's CSS 3D). The head is the bot's
 * real 12×12 sprite (so the mono pupil fix and every part show exactly as in
 * the lists); a pixel neck, torso and arms below it carry the body tones and
 * the colour band of the design's block character, so Body and Walk are
 * visible too. Motion comes from CSS classes; reduced motion stops it.
 */
export function PixelFigure({
  appearance,
  motion,
  cell = 12,
}: PixelFigureProps) {
  const head = spritePathsFor(
    appearance,
    motion === "work" ? "working" : "idle",
  );
  const body = BODY_TONES[appearance.body];
  const colour = COLOUR_RAMPS[appearance.colour];
  return (
    <div
      className={`studio-figure studio-figure--${motion} studio-figure--${appearance.gait}`}
      data-motion={motion}
      data-gait={appearance.gait}
    >
      <span className="studio-figure__shadow" />
      <div className="studio-figure__bobber">
        {motion === "talk" && (
          <span className="studio-figure__typing">
            <TypingDots />
          </span>
        )}
        <svg
          className="studio-figure__svg"
          viewBox="0 0 12 19"
          width={12 * cell}
          height={19 * cell}
          shapeRendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          <g className="studio-figure__arm studio-figure__arm--left">
            <Px x={0} y={13} w={2} fill={colour.t} />
            <Px x={0} y={14} h={4} fill={colour.s} />
            <Px x={1} y={14} h={4} fill={colour.f} />
          </g>
          <g className="studio-figure__arm studio-figure__arm--right">
            <Px x={10} y={13} w={2} fill={colour.t} />
            <Px x={10} y={14} h={4} fill={colour.f} />
            <Px x={11} y={14} h={4} fill={colour.s} />
          </g>
          <g className="studio-figure__torso">
            <Px x={5} y={11} w={2} fill={NECK} />
            <Px x={2} y={12} w={8} fill={body.t} />
            <Px x={2} y={13} w={7} h={6} fill={body.f} />
            <Px x={9} y={13} h={6} fill={body.s} />
            <Px x={2} y={15} w={7} fill={colour.f} />
            <Px x={9} y={15} fill={colour.s} />
          </g>
          <g className="studio-figure__head">
            {head.map((path) => (
              <path key={path.fill} fill={path.fill} d={path.d} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
