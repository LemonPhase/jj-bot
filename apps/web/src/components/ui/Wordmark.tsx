import type { CSSProperties } from "react";
import { PixelIcon } from "../sprite/PixelIcon";
import { cx } from "./cx";
import "./ui.css";

export interface WordmarkProps {
  /** Mark width in px, a multiple of 12: 24 in the sidebar (default), 36 on the System sheet. */
  markSize?: number;
  className?: string;
}

/**
 * The brand: the pixel mark plus "JJ BOT" in Silkscreen (the only place the
 * pixel font is used). Wrap it in a link to Bots where it navigates.
 */
export function Wordmark({ markSize = 24, className }: WordmarkProps) {
  return (
    <span
      className={cx("ui-wordmark", className)}
      style={{ "--wordmark-mark": `${markSize}px` } as CSSProperties}
    >
      <PixelIcon name="brand" size={markSize} />
      <span>JJ BOT</span>
    </span>
  );
}
