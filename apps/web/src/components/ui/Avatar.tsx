import type { BotAppearance, BotColour } from "@jj/contracts";
import type { ReactNode } from "react";
import type { Mood } from "../../lib/status";
import { PixelSprite } from "../sprite/PixelSprite";
import "./ui.css";

export interface AvatarProps {
  /** The bot's appearance. When missing (an unknown or deleted bot), a lettered tile stands in. */
  appearance?: Pick<
    BotAppearance,
    "shape" | "face" | "topper" | "colour"
  > | null;
  /** The bot's name: the accessible label, and the fallback's letter. */
  name: string;
  mood?: Mood;
  /** CSS px; the design uses 24, 36, 48 and 60. Default 24. */
  size?: number;
  /** Default true; only the working mood animates. */
  animate?: boolean;
  /** Hide from assistive technology when the name is already next to it. */
  decorative?: boolean;
}

/**
 * A bot's picture: its pixel sprite, or a neutral lettered tile when the
 * appearance is unknown. The fallback never invents a look for a real bot.
 *
 * @example <Avatar appearance={bot.appearance} name={bot.name} mood={moodForStatus(bot.presence)} size={36} decorative />
 */
export function Avatar({
  appearance,
  name,
  mood = "idle",
  size = 24,
  animate = true,
  decorative = false,
}: AvatarProps) {
  if (appearance) {
    return (
      <PixelSprite
        appearance={appearance}
        mood={mood}
        size={size}
        animate={animate}
        label={decorative ? undefined : name}
      />
    );
  }
  const letter = Array.from(name.trim())[0] ?? "?";
  return (
    <span
      className="ui-avatar-fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": name })}
    >
      {letter}
    </span>
  );
}

export interface MentionProps {
  /** The mentioned bot's colour. */
  colour: BotColour;
  children: ReactNode;
}

/**
 * An @mention in task chat: the bot's colour as text, weight 500. The colour
 * comes from the `--mention-<colour>` token, which reaches 4.5:1 in both themes.
 *
 * @example <Mention colour={moss.appearance.colour}>@Moss</Mention>
 */
export function Mention({ colour, children }: MentionProps) {
  return (
    <span className="ui-mention" style={{ color: `var(--mention-${colour})` }}>
      {children}
    </span>
  );
}
