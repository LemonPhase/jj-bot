import type { BotGlyph, BotProfile } from "../../api/types";

type AvatarSize = "sm" | "md" | "lg";

function Face({ glyph, color }: { glyph: BotGlyph; color: string }) {
  switch (glyph) {
    case "visor":
      return (
        <>
          <rect x="7" y="11" width="18" height="8" rx="4" fill={color} />
          <circle cx="12.5" cy="15" r="1.6" fill="#fff" />
          <circle cx="19.5" cy="15" r="1.6" fill="#fff" />
          <line
            x1="16"
            y1="6"
            x2="16"
            y2="10"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      );
    case "radar":
      return (
        <>
          <circle
            cx="12"
            cy="16"
            r="4"
            stroke={color}
            strokeWidth="2"
            fill="none"
          />
          <circle
            cx="20"
            cy="16"
            r="4"
            stroke={color}
            strokeWidth="2"
            fill="none"
          />
          <circle cx="12" cy="16" r="1.4" fill={color} />
          <circle cx="20" cy="16" r="1.4" fill={color} />
          <path
            d="M13 9 Q16 6 19 9"
            stroke={color}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
        </>
      );
    case "pixel":
      return (
        <>
          <rect
            x="8"
            y="10"
            width="16"
            height="12"
            rx="2.5"
            stroke={color}
            strokeWidth="2"
            fill="none"
          />
          <rect x="11.5" y="14" width="2.8" height="2.8" fill={color} />
          <rect x="17.7" y="14" width="2.8" height="2.8" fill={color} />
        </>
      );
    case "prism":
      return (
        <>
          <polygon
            points="16,7 25,16 16,25 7,16"
            stroke={color}
            strokeWidth="2"
            fill="none"
            strokeLinejoin="round"
          />
          <circle cx="13.5" cy="15.5" r="1.5" fill={color} />
          <circle cx="18.5" cy="15.5" r="1.5" fill={color} />
        </>
      );
    default:
      return (
        <>
          <path
            d="M8 16 Q12 10 16 16 T24 16"
            stroke={color}
            strokeWidth="2.2"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="1.5" fill={color} />
          <circle cx="20" cy="12" r="1.5" fill={color} />
        </>
      );
  }
}

export function BotAvatar({
  bot,
  size = "md",
  presence = false,
}: {
  bot: Pick<BotProfile, "color" | "glyph" | "presence">;
  size?: AvatarSize;
  /** Show the online/busy dot. */
  presence?: boolean;
}) {
  return (
    <div className="bot-avatar-wrap">
      <div
        className={`bot-avatar ${size === "md" ? "" : size}`}
        style={{
          background: `${bot.color}18`,
          border: `1px solid ${bot.color}38`,
        }}
      >
        <svg width="76%" height="76%" viewBox="0 0 32 32" aria-hidden="true">
          <Face glyph={bot.glyph} color={bot.color} />
        </svg>
      </div>
      {presence && (
        <span
          className={`presence-dot ${bot.presence === "busy" ? "busy" : ""}`}
        />
      )}
    </div>
  );
}
