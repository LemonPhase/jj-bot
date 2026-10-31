import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("labels the field for assistive technology and starts unable to send", () => {
    const html = renderToStaticMarkup(
      <Composer
        label="Message Juno"
        placeholder="Message Juno…"
        onSubmit={() => {}}
      />,
    );
    expect(html).toMatch(
      /<label for="([^"]+)" class="visually-hidden">Message Juno<\/label>/,
    );
    const id = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('placeholder="Message Juno…"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).toContain("ui-composer--bot");
  });

  it("renders the task variant with leading controls and a disabled field", () => {
    const html = renderToStaticMarkup(
      <Composer
        variant="task"
        label="Message the task"
        placeholder="This task was stopped"
        disabled
        leading={<button type="button">steer</button>}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain("ui-composer--task");
    expect(html).toContain("data-disabled");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html.indexOf("steer")).toBeLessThan(html.indexOf("<textarea"));
  });
});
