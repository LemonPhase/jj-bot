import type { BotAppearance } from "@jj/contracts";
import { type Mood, moodAnimates } from "../../lib/status";
import { spritePathsFor } from "./compose";
import "./sprite.css";

export interface PixelSpriteProps {
  /** The bot's appearance from the contract. Only shape, face, topper and colour affect the sprite. */
  appearance: Pick<BotAppearance, "shape" | "face" | "topper" | "colour">;
  /** Default `idle`. Use `moodForStatus()` from src/lib/status.ts to pick one. */
  mood?: Mood;
  /**
   * Rendered width and height in CSS px. Multiples of 12 (24, 36, 48, 60 in the
   * design) keep every sprite pixel the same size; other sizes stay crisp.
   */
  size?: number;
  /**
   * Plays the mood's animation (only `working` has one: the `bob`). Default true.
   * `prefers-reduced-motion: reduce` always turns it off.
   */
  animate?: boolean;
  /** Accessible name. Without it the sprite is decorative (`aria-hidden`). */
  label?: string;
  className?: string;
}

/**
 * A bot's 12×12 pixel sprite as one crisp SVG (one path per colour).
 *
 * @example <PixelSprite appearance={bot.appearance} mood={moodForStatus(session)} size={36} />
 */
export function PixelSprite({
  appearance,
  mood = "idle",
  size = 24,
  animate = true,
  label,
  className,
}: PixelSpriteProps) {
  const paths = spritePathsFor(appearance, mood);
  const classes = ["ui-sprite"];
  if (animate && moodAnimates(mood)) classes.push("ui-sprite--bob");
  if (className) classes.push(className);
  return (
    <svg
      className={classes.join(" ")}
      viewBox="0 0 12 12"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-mood={mood}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
    >
      {paths.map((path) => (
        <path key={path.fill} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}
