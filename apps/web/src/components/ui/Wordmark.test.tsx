import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("draws a 24px mark by default and hands its size to the gap", () => {
    const html = renderToStaticMarkup(<Wordmark />);
    expect(html).toContain('style="--wordmark-mark:24px"');
    expect(html).toContain('width="24"');
    expect(html).toContain(">JJ BOT</span>");
  });

  it("scales the mark, and with it the gap, on the System sheet", () => {
    const html = renderToStaticMarkup(<Wordmark markSize={36} />);
    expect(html).toContain('style="--wordmark-mark:36px"');
    expect(html).toContain('width="36"');
  });
});
