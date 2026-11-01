import type { BotAppearance } from "@jj/contracts";
import { PixelSprite } from "../../components/sprite";
import { Badge, SectionLabel, Segmented } from "../../components/ui";
import { appearanceSummary, GAIT_NOTES } from "../../lib/appearance";
import { PixelFigure, type PreviewMotion } from "./PixelFigure";

const MOTIONS: readonly { value: PreviewMotion; label: string }[] = [
  { value: "idle", label: "Idle" },
  { value: "walk", label: "Walk" },
  { value: "talk", label: "Talk" },
  { value: "work", label: "Work" },
];

/** What the 2D preview really shows for each motion (it has no blink or mouth). */
export function motionNote(motion: PreviewMotion, appearance: BotAppearance) {
  switch (motion) {
    case "idle":
      return "Idle · floats in place";
    case "walk":
      return `Walk · ${GAIT_NOTES[appearance.gait]}`;
    case "talk":
      return "Talk · nods and gestures";
    case "work":
      return "Work · focused, arms tapping";
  }
}

export interface StudioPreviewProps {
  appearance: BotAppearance;
  /** The bot's name as typed; a placeholder is shown while it is empty. */
  name: string;
  motion: PreviewMotion;
  onMotionChange: (motion: PreviewMotion) => void;
}

/**
 * The left column of Bot Studio (SPEC §11): the stage, the preview-motion
 * switch and the pixel-avatar card. Everything here is labelled "Preview":
 * nothing on this screen is a real status.
 */
export function StudioPreview({
  appearance,
  name,
  motion,
  onMotionChange,
}: StudioPreviewProps) {
  const shown = name.trim() || "New bot";
  const summary = appearanceSummary(appearance);
  const note = motionNote(motion, appearance);
  return (
    <section aria-label="Preview" className="studio-preview">
      <div
        className="studio-stage"
        role="img"
        aria-label={`Preview of ${shown}: ${summary}. ${note}.`}
      >
        <div
          className={`studio-stage__floor${motion === "walk" ? " studio-stage__floor--scroll" : ""}`}
        />
        <PixelFigure appearance={appearance} motion={motion} />
        <div className="studio-stage__caption">
          <span
            className={`studio-stage__name${name.trim() ? "" : " studio-stage__name--placeholder"}`}
          >
            {shown}
          </span>
          <span className="studio-stage__summary">{summary}</span>
        </div>
        <Badge className="studio-stage__badge">Preview</Badge>
      </div>

      <div className="studio-motion">
        <Segmented
          variant="compact"
          label="Preview motion"
          className="studio-motion__switch"
          value={motion}
          onChange={onMotionChange}
          options={MOTIONS}
        />
        <span className="studio-motion__note" aria-live="polite">
          {note}
        </span>
      </div>

      <div className="studio-avatar">
        <SectionLabel tracking="part">Pixel avatar</SectionLabel>
        <div className="studio-avatar__sizes">
          {[24, 36, 48].map((size) => (
            <PixelSprite
              key={size}
              appearance={appearance}
              size={size}
              label={`${size} pixel sprite`}
            />
          ))}
        </div>
        <div className="studio-avatar__sample">
          <PixelSprite appearance={appearance} size={36} />
          <span className="studio-avatar__text">
            <span className="studio-avatar__name clamp1">{shown}</span>
            <span className="studio-avatar__status">
              Preview · as listed in the sidebar
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
