import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PixelSprite } from "./PixelSprite";

const juno = {
  shape: "squircle",
  face: "visor",
  topper: "antenna",
  colour: "coral",
} as const;

describe("PixelSprite", () => {
  it("renders a crisp 12-unit SVG at the requested size, decorative by default", () => {
    const html = renderToStaticMarkup(
      <PixelSprite appearance={juno} size={36} />,
    );
    expect(html).toContain('viewBox="0 0 12 12"');
    expect(html).toContain('width="36"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('fill="#FF7A66"');
    expect(html).not.toContain("ui-sprite--bob");
  });

  it("bobs only in the working mood, and only when animated", () => {
    const working = renderToStaticMarkup(
      <PixelSprite appearance={juno} mood="working" />,
    );
    expect(working).toContain("ui-sprite--bob");
    expect(working).toContain('data-mood="working"');
    const still = renderToStaticMarkup(
      <PixelSprite appearance={juno} mood="working" animate={false} />,
    );
    expect(still).not.toContain("ui-sprite--bob");
  });

  it("exposes a name when labelled", () => {
    const html = renderToStaticMarkup(
      <PixelSprite appearance={juno} label="Juno" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Juno"');
    expect(html).not.toContain("aria-hidden");
  });
});
