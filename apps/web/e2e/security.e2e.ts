import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures";

// The security headers as a browser applies them (apps/api/src/headers.ts):
// the app runs under its Content-Security-Policy (every test's page fails on
// a violation, see fixtures.ts), and another site cannot frame it, so its
// buttons, such as Approve on a held call, cannot be clickjacked.

/**
 * A page of another site (`localhost`, not the app's `127.0.0.1`) on this
 * machine, on both loopback addresses, whichever `localhost` resolves to.
 */
async function otherSite(html: string) {
  const serve = () =>
    createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
    });
  const listen = (server: Server, port: number, host: string) =>
    new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, host, () => resolve(true));
    });
  const v4 = serve();
  if (!(await listen(v4, 0, "127.0.0.1")))
    throw new Error("cannot listen on 127.0.0.1");
  const { port } = v4.address() as AddressInfo;
  // Without IPv6, or with the port taken there, IPv4 alone serves it.
  const v6 = serve();
  const servers = (await listen(v6, port, "::1")) ? [v4, v6] : [v4];
  return {
    url: `http://localhost:${port}/`,
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      ),
  };
}

test("another site cannot frame the app", async ({ browser, instance }) => {
  const control = `${instance.url}/framing-control`;
  const site = await otherSite(`<!doctype html><title>Win a prize</title>
    <iframe name="app" src="${instance.url}/" width="800" height="400"></iframe>
    <iframe name="control" src="${control}" width="200" height="100"></iframe>`);
  // A context of its own: the refusal is a CSP report, which the test's
  // page would count as a violation of the app's own.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const refusals: string[] = [];
    page.on("console", (message) => {
      if (/frame-ancestors/.test(message.text())) refusals.push(message.text());
    });
    // The app's origin answering without its headers: that frame shows, so
    // only the headers refuse the other.
    await page.route(control, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><p>Framed</p>",
      }),
    );
    const answer = page.waitForResponse(
      (response) => response.url() === `${instance.url}/`,
    );
    await page.goto(site.url);
    // The app's page reaches the browser, which refuses to show it.
    const app = await answer;
    expect(app.status()).toBe(200);
    expect(app.headers()["x-frame-options"]).toBe("DENY");
    await expect
      .poll(() => page.frame({ name: "control" })?.locator("p").textContent())
      .toBe("Framed");
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    expect(refusals.join("\n")).toContain("frame-ancestors 'none'");
    const framed = page.frame({ name: "app" });
    expect(framed).toBeTruthy();
    expect(
      await framed
        ?.evaluate(() => Boolean(document.querySelector("#root")))
        .catch(() => false),
    ).toBe(false);
  } finally {
    await context.close();
    await site.close();
  }
});
