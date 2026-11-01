import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Office2D } from "./Office2D";
import {
  nextSpeed,
  OFFICE_MODE_KEY,
  readOfficeMode,
  writeOfficeMode,
} from "./playback";
import { bot, session, task, taskView } from "./testFixtures";

const team = (n: number) =>
  Array.from({ length: n }, (_, i) => bot(`bot-${i}`, `Bot ${i}`));

function render(n: number, sessions = [] as ReturnType<typeof session>[]) {
  const bots = team(n);
  const view = taskView({
    task: task({
      coordinatorBotId: bots[0]?.id ?? "bot-0",
      participantBotIds: bots.length ? bots.map((b) => b.id) : ["bot-0"],
    }),
    sessions,
  });
  return renderToStaticMarkup(
    <Office2D
      view={view}
      bots={bots}
      beats={[]}
      paused={false}
      speed={1}
      reducedMotion={false}
      onStatus={() => {}}
    />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Office2D", () => {
  it.each([0, 1, 2, 3, 5, 6, 7, 11])(
    "draws a desk per bot in a wrapping grid, the rest free (%i bots)",
    (n) => {
      const html = render(n);
      const desks = Math.max(6, Math.ceil(n / 3) * 3);
      expect(count(html, 'data-desk="occupied"')).toBe(n);
      expect(count(html, 'data-desk="free"')).toBe(desks - n);
      expect(count(html, "data-bot=")).toBe(n);
      const height = 104 + 30 * (Math.max(2, Math.ceil(n / 3)) - 2);
      expect(html).toContain(`viewBox="0 0 160 ${height}"`);
    },
  );

  it("lights each monitor with its bot's real status colour, from the theme tokens", () => {
    const html = render(3, [
      session({ id: "a", botId: "bot-0", status: "running" }),
      session({
        id: "b",
        botId: "bot-1",
        status: "completed",
        parentSessionId: "a",
      }),
    ]);
    expect(html).toContain("fill:var(--status-running)");
    expect(html).toContain("fill:var(--status-completed)");
    // Bot 2 has no session: an idle screen, never a made-up status.
    expect(html).toContain("fill:var(--status-idle)");
    expect(html).not.toContain("#60A5FA");
  });

  it("bobs only working bots and is an accessible image", () => {
    const html = render(2, [
      session({ id: "a", botId: "bot-0", status: "running" }),
    ]);
    expect(count(html, 'class="o2d-bob"')).toBe(1);
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Pixel office acting out the task conversation"',
    );
  });
});

describe("office playback helpers", () => {
  it("remembers the 2D/3D choice and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readOfficeMode("2d", storage)).toBe("2d");
    expect(writeOfficeMode("3d", storage)).toBe(true);
    expect(store.get(OFFICE_MODE_KEY)).toBe("3d");
    expect(readOfficeMode("2d", storage)).toBe("3d");
    store.set(OFFICE_MODE_KEY, "4d");
    expect(readOfficeMode("2d", storage)).toBe("2d");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readOfficeMode("3d", broken)).toBe("3d");
    expect(writeOfficeMode("2d", broken)).toBe(false);
    expect(writeOfficeMode("2d", null)).toBe(false);
  });

  it("cycles speed 1× → 2× → 3× → 1×", () => {
    expect([nextSpeed(1), nextSpeed(2), nextSpeed(3)]).toEqual([2, 3, 1]);
  });
});
