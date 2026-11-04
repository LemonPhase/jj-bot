import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  API_ERROR_CODES,
  CONTRACT_VERSION,
  capabilitiesSchema,
  DEFAULT_KEEP_WORKSPACES,
  MAX_KEEP_WORKSPACES,
  SCHEDULE_PAUSED_REASONS,
  type StoredTrigger,
  scheduleDetailSchema,
  scheduleFireSchema,
  scheduleSchema,
  taskEventSchema,
  taskObjectSchema,
  templateInUseDetailsSchema,
  workspaceHintSchema,
} from "./index";
import {
  createScheduleCommandSchema,
  cronProblem,
  firesBetween,
  formatFireTime,
  minimumGapMinutes,
  nextFires,
  parseCron,
  scheduleTriggerSchema,
  timeZoneSchema,
  triggerProblem,
  updateScheduleCommandSchema,
  wallTimeToInstant,
} from "./schedule-rules";

const at = "2026-11-03T12:00:00.000Z";
const cron = (expression: string, timeZone = "UTC"): StoredTrigger => ({
  kind: "cron",
  cron: expression,
  timeZone,
});
const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

describe("contract version 1.11.0 (schedules)", () => {
  it("is 1.11.0, and the changelog's newest entry records it", () => {
    expect(CONTRACT_VERSION).toBe("1.11.0");
    const changelog = readFileSync(
      new URL("../../../docs/contract-changelog.md", import.meta.url),
      "utf8",
    );
    const newest = /^## (\d+\.\d+\.\d+) — /m.exec(changelog)?.[1];
    expect(newest).toBe(CONTRACT_VERSION);
    expect(changelog).toMatch(/^## 1\.11\.0 — .* — Schedules$/m);
  });

  it("adds TEMPLATE_IN_USE, the schedules.changed hint and capabilities.schedules (false by default)", () => {
    expect(API_ERROR_CODES).toContain("TEMPLATE_IN_USE");
    expect(workspaceHintSchema.parse({ type: "schedules.changed" })).toEqual({
      type: "schedules.changed",
    });
    const older = {
      agentExecution: true,
      persistence: true,
      streaming: true,
      verification: true,
      drivers: [],
    };
    expect(capabilitiesSchema.parse(older).schedules).toBe(false);
    expect(
      templateInUseDetailsSchema.safeParse({ schedules: [] }).success,
    ).toBe(false);
  });

  it("gives tasks a scheduleId, null for tasks stored before schedules", () => {
    const task = {
      id: "t1",
      title: "T",
      goal: "G",
      goalVersion: 1,
      coordinatorBotId: "b",
      participantBotIds: ["b"],
      status: "queued",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    expect(taskObjectSchema.parse(task).scheduleId).toBeNull();
    expect(
      taskObjectSchema.parse({ ...task, scheduleId: "s1" }).scheduleId,
    ).toBe("s1");
  });

  it("adds the workspace.removed marker event", () => {
    const event = taskEventSchema.parse({
      id: "e1",
      taskId: "t1",
      sequence: 9,
      occurredAt: at,
      botId: null,
      sessionId: null,
      runId: null,
      causedBy: null,
      type: "workspace.removed",
      payload: { scheduleId: "s1", keepWorkspaces: 3 },
    });
    expect(event.type).toBe("workspace.removed");
  });
});

describe("cron grammar", () => {
  it.each([
    ["* * * * *"],
    ["0 9 * * 1-5"],
    ["*/15 0-6,22-23 * * *"],
    ["0-30/10 * * * *"],
    ["0 9 1,15 * *"],
    ["0 12 * JAN-MAR,DEC mon-fri"],
    ["0 0 * * 7"],
    ["0 0 * * SUN"],
    ["  0   9  *  *  *  "],
  ])("accepts %j", (expression) => {
    expect(cronProblem(expression)).toBeUndefined();
  });

  it.each([
    ["", /Enter a schedule/],
    ["@daily", /Macros such as @daily are not supported/],
    ["@every 5m", /Macros/],
    ["0 0 9 * * *", /6 fields: a seconds or year field is not supported/],
    ["0 9 * *", /Use 5 fields .* this has 4/],
    ["0 0 L * *", /L, W, # and \? are not supported/],
    ["0 0 15W * *", /L, W, # and \? are not supported/],
    ["0 0 * * 5L", /L, W, # and \? are not supported/],
    ["0 0 * * 1#2", /L, W, # and \? are not supported/],
    ["0 0 ? * MON", /L, W, # and \? are not supported/],
    ["60 * * * *", /minute: 60 is out of range 0–59/],
    ["0 24 * * *", /hour: 24 is out of range 0–23/],
    ["0 0 0 * *", /day of month: 0 is out of range 1–31/],
    ["0 0 * 13 *", /month: 13 is out of range 1–12/],
    ["0 0 * * 8", /day of week: 8 is out of range 0–7/],
    ["0 22-2 * * *", /must go from low to high/],
    ["*/0 * * * *", /at least 1/],
    ["*/61 * * * *", /larger than the field/],
    ["5/10 * * * *", /a step follows \* or a range/],
    ["0 0 * FOO *", /"FOO" is not a number or a name \(JAN–DEC\)/],
    ["0 MON * * *", /hour: "MON" is not a number/],
    ["0,,5 * * * *", /empty item/],
    ["1-2-3 * * * *", /is not a range/],
    ["*/5/2 * * * *", /more than one step/],
  ])("refuses %j", (expression, problem) => {
    expect(cronProblem(expression)).toMatch(problem);
  });

  it("folds day of week 7 into Sunday and reads names in any case", () => {
    const parsed = parseCron("0 0 * jan sun,7");
    expect(parsed.ok && parsed.fields.weekdays).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(parsed.ok && parsed.fields.months[1]).toBe(true);
  });

  it("matches either day field when both are restricted, as Vixie cron does", () => {
    // The 1st of the month, or any Monday.
    expect(
      iso(nextFires(cron("0 0 1 * 1"), new Date("2026-11-27T12:00:00Z"), 4)),
    ).toEqual([
      "2026-11-30T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      "2026-12-07T00:00:00.000Z",
      "2026-12-14T00:00:00.000Z",
    ]);
    // A field that starts with * is unrestricted: odd days that are Mondays.
    expect(
      iso(nextFires(cron("0 0 */2 * 1"), new Date("2026-11-01T12:00:00Z"), 2)),
    ).toEqual(["2026-11-09T00:00:00.000Z", "2026-11-23T00:00:00.000Z"]);
  });
});

describe("nextFires", () => {
  it("returns the next n fires strictly after a time, on the zone's wall clock", () => {
    expect(
      iso(
        nextFires(
          cron("0 9 * * 1-5", "Europe/London"),
          new Date("2026-11-06T09:00:00Z"),
          3,
        ),
      ),
    ).toEqual([
      "2026-11-09T09:00:00.000Z",
      "2026-11-10T09:00:00.000Z",
      "2026-11-11T09:00:00.000Z",
    ]);
    expect(
      iso(
        nextFires(
          cron("0 9 * * *", "America/New_York"),
          new Date("2026-07-01T00:00:00Z"),
          1,
        ),
      ),
    ).toEqual(["2026-07-01T13:00:00.000Z"]);
  });

  it("is empty for an expression that never fires, or one that does not parse", () => {
    expect(nextFires(cron("0 0 30 2 *"), new Date(at), 3)).toEqual([]);
    expect(nextFires(cron("0 0 31 4,6,9,11 *"), new Date(at), 3)).toEqual([]);
    expect(nextFires(cron("@daily"), new Date(at), 3)).toEqual([]);
  });

  it("throws for a zone this runtime does not know", () => {
    expect(() =>
      nextFires(cron("0 9 * * *", "Mars/Base"), new Date(at), 1),
    ).toThrow(RangeError);
  });
});

describe("daylight saving", () => {
  const zones = {
    // Clocks go from 01:00 GMT to 02:00 BST, and back from 02:00 BST to 01:00 GMT.
    "Europe/London": {
      gap: { day: "2026-03-29", skipped: "30 1", end: "01:00", next: "00:30" },
      overlap: { day: "2026-10-25", repeated: "30 1", first: "00:30" },
    },
    // Clocks go from 02:00 EST to 03:00 EDT, and back from 02:00 EDT to 01:00 EST.
    "America/New_York": {
      gap: { day: "2026-03-08", skipped: "30 2", end: "07:00", next: "06:30" },
      overlap: { day: "2026-11-01", repeated: "30 1", first: "05:30" },
    },
  } as const;

  describe.each(Object.entries(zones))("%s", (zone, { gap, overlap }) => {
    it("runs a wall time the change skips once, at the end of the gap", () => {
      const before = new Date(`${gap.day}T12:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      const fires = iso(
        nextFires(cron(`${gap.skipped} * * *`, zone), before, 2),
      );
      const nextDay = new Date(`${gap.day}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      expect(fires).toEqual([
        `${gap.day}T${gap.end}:00.000Z`,
        `${nextDay.toISOString().slice(0, 10)}T${gap.next}:00.000Z`,
      ]);
    });

    it("runs every skipped wall time of an expression once, with no duplicate", () => {
      const before = new Date(`${gap.day}T00:00:00Z`);
      const fires = firesBetween(
        cron("*/15 * * * *", zone),
        before,
        new Date(before.getTime() + 24 * 3600_000),
        200,
      );
      const instants = fires.map((date) => date.getTime());
      expect(new Set(instants).size).toBe(instants.length);
      expect(instants).toEqual([...instants].sort((a, b) => a - b));
      expect(iso(fires)).toContain(`${gap.day}T${gap.end}:00.000Z`);
    });

    it("runs a wall time the change repeats once, at its first occurrence", () => {
      const before = new Date(`${overlap.day}T12:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      const fires = iso(
        nextFires(cron(`${overlap.repeated} * * *`, zone), before, 2),
      );
      expect(fires[0]).toBe(`${overlap.day}T${overlap.first}:00.000Z`);
      // The next day's run is a day and an hour later in real time.
      const gapMs =
        Date.parse(fires[1] as string) - Date.parse(fires[0] as string);
      expect(gapMs).toBe(25 * 3600_000);
    });

    it("maps wall times as its rules say", () => {
      const wall = Date.parse(
        `${overlap.day}T${overlap.repeated.split(" ")[1]?.padStart(2, "0")}:30:00Z`,
      );
      expect(new Date(wallTimeToInstant(wall, zone)).toISOString()).toBe(
        `${overlap.day}T${overlap.first}:00.000Z`,
      );
    });

    it("measures the interval on the wall clock, so an hourly run stays hourly", () => {
      const from = new Date(`${gap.day}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 2);
      expect(minimumGapMinutes(cron("30 * * * *", zone), from)).toBe(60);
      expect(minimumGapMinutes(cron("0 * * * *", zone), from)).toBe(60);
    });
  });
});

describe("minimumGapMinutes and triggerProblem", () => {
  const from = new Date(at);

  it("gives the shortest wall-clock gap between consecutive fires", () => {
    expect(minimumGapMinutes(cron("*/30 * * * *"), from)).toBe(30);
    expect(minimumGapMinutes(cron("0 9 * * 1-5", "Europe/London"), from)).toBe(
      1440,
    );
    expect(minimumGapMinutes(cron("0 9,10 * * *"), from)).toBe(60);
    expect(minimumGapMinutes(cron("0 0 30 2 *"), from)).toBeNull();
  });

  it("refuses a gap under the minimum and a schedule that never fires", () => {
    expect(triggerProblem(cron("*/30 * * * *"), from, 60)).toMatch(
      /30 minutes apart at times, under this server's minimum of 60 minutes/,
    );
    expect(triggerProblem(cron("0 0 30 2 *"), from, 60)).toMatch(
      /never runs: no time in the next 8 years matches it/,
    );
    expect(triggerProblem(cron("0 * * * *", "Europe/London"), from, 60)).toBe(
      undefined,
    );
    expect(triggerProblem(cron("0 * * * *", "Nowhere/Land"), from, 60)).toMatch(
      /not a time zone/,
    );
    expect(triggerProblem(cron("0 0 * * * *"), from, 60)).toMatch(/6 fields/);
  });

  it("finds a leap day's next fire however far ahead, across a century without one", () => {
    const leap = cron("0 0 29 2 *");
    // Saved in mid-2027: the next 29 February is 2028's, 9 months on.
    expect(iso(nextFires(leap, new Date("2027-06-01T00:00:00Z"), 1))).toEqual([
      "2028-02-29T00:00:00.000Z",
    ]);
    // After a fire, the next is four years on: still found.
    expect(iso(nextFires(leap, new Date("2028-02-29T00:00:01Z"), 1))).toEqual([
      "2032-02-29T00:00:00.000Z",
    ]);
    // 2100 is no leap year: 2096's next is 2104's, eight years on.
    expect(iso(nextFires(leap, new Date("2096-02-29T00:00:01Z"), 1))).toEqual([
      "2104-02-29T00:00:00.000Z",
    ]);
    expect(triggerProblem(leap, new Date(at), 60)).toBeUndefined();
  });

  it("stops measuring at the first gap under the minimum", () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      // Every two minutes: about 263,000 fires a year, refused at its first gap.
      expect(triggerProblem(cron("*/2 * * * *"), from, 60)).toMatch(
        /2 minutes apart at times/,
      );
      expect(spy.mock.calls.length).toBeLessThan(20);
      expect(minimumGapMinutes(cron("*/2 * * * *"), from, 60)).toBe(2);
    } finally {
      spy.mockRestore();
    }
    // Without a bound, or above it, the walk finds the true minimum.
    expect(minimumGapMinutes(cron("0 9,10 * * *"), from, 30)).toBe(60);
    expect(minimumGapMinutes(cron("0 9,10 * * *"), from)).toBe(60);
  });

  it("can bring two runs closer in real time than on the wall clock, as documented", () => {
    // 00:59 GMT, then 01:59 is skipped and runs at the end of the gap: 02:00 BST.
    const fires = iso(
      firesBetween(
        cron("59 * * * *", "Europe/London"),
        new Date("2026-03-29T00:30:00Z"),
        new Date("2026-03-29T02:30:00Z"),
        10,
      ),
    );
    expect(fires.slice(0, 2)).toEqual([
      "2026-03-29T00:59:00.000Z",
      "2026-03-29T01:00:00.000Z",
    ]);
    expect(
      minimumGapMinutes(
        cron("59 * * * *", "Europe/London"),
        new Date("2026-03-28T00:00:00Z"),
      ),
    ).toBe(60);
  });

  it("consults the zone a bounded number of times per day, never per minute", () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      const started = performance.now();
      // Every minute of every day: a gap of one minute ends the walk early.
      expect(minimumGapMinutes(cron("* * * * *", "Europe/London"), from)).toBe(
        1,
      );
      // Two walks over a whole year of 35,000 fires, across a change each.
      expect(
        firesBetween(
          cron("*/15 * * * *", "America/New_York"),
          from,
          new Date(from.getTime() + 366 * 24 * 3600_000),
          100_000,
        ),
      ).toHaveLength(366 * 96);
      expect(
        minimumGapMinutes(cron("*/15 * * * *", "Europe/London"), from),
      ).toBe(15);
      // A year in which no day matches reads no offset at all.
      expect(nextFires(cron("* * 30 2 *", "Europe/London"), from, 1)).toEqual(
        [],
      );
      // About 2 readings per day walked, plus about 20 per day near a change;
      // reading per fire would take more than 70,000.
      expect(spy.mock.calls.length).toBeLessThan(2_500);
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("time zones", () => {
  it("stores a zone in canonical form", () => {
    expect(timeZoneSchema.parse("europe/london")).toBe("Europe/London");
    expect(timeZoneSchema.parse(" UTC ")).toBe("UTC");
  });

  it.each([["Mars/Base"], ["+05:00"], ["UTC+1"], [""], ["../etc/passwd"]])(
    "refuses %j",
    (zone) => {
      expect(timeZoneSchema.safeParse(zone).success).toBe(false);
    },
  );

  it("formats a fire on the schedule's wall clock", () => {
    expect(
      formatFireTime(new Date("2026-11-04T09:00:00Z"), "Europe/London"),
    ).toBe("2026-11-04 09:00 Europe/London");
    expect(
      formatFireTime(new Date("2026-07-04T13:05:00Z"), "America/New_York"),
    ).toBe("2026-07-04 09:05 America/New_York");
  });
});

describe("schedule records and commands", () => {
  const fire = {
    id: "f1",
    scheduleId: "s1",
    scheduledFor: at,
    recordedAt: at,
    outcome: "refused",
    reason: "Writer reached its daily spend cap.",
    missedCount: 0,
    taskId: null,
    code: "SPEND_CAP_REACHED",
    details: { scope: "bot", spentUsd: 20, capUsd: 20, botId: "b" },
  } as const;
  const schedule = {
    id: "s1",
    name: "Morning digest",
    templateId: "tmpl1",
    trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "Europe/London" },
    enabled: true,
    nextFireAt: at,
    createdAt: at,
    updatedAt: at,
  };

  it("names why the server paused a schedule", () => {
    expect(SCHEDULE_PAUSED_REASONS).toEqual([
      "template_unusable",
      "interval_too_short",
      "no_next_fire",
    ]);
  });

  it("reads a schedule with its defaults", () => {
    const parsed = scheduleSchema.parse(schedule);
    expect(parsed).toMatchObject({
      instructions: "",
      overlap: "skip",
      keepWorkspaces: DEFAULT_KEEP_WORKSPACES,
      chatUpdates: "attention",
      pausedReason: null,
      lastFire: null,
    });
    expect(
      scheduleDetailSchema.parse({ schedule, fires: [fire] }).fires[0]?.code,
    ).toBe("SPEND_CAP_REACHED");
    expect(scheduleFireSchema.parse({ ...fire, code: undefined }).code).toBe(
      null,
    );
  });

  it("parses a create command: canonical zone, tidy cron, refusals inline", () => {
    const parsed = createScheduleCommandSchema.parse({
      name: "  Digest  ",
      templateId: "tmpl1",
      trigger: {
        kind: "cron",
        cron: " 0  9 * *  1-5 ",
        timeZone: "europe/london",
      },
    });
    expect(parsed.name).toBe("Digest");
    expect(parsed.trigger).toEqual({
      kind: "cron",
      cron: "0 9 * * 1-5",
      timeZone: "Europe/London",
    });
    expect(
      createScheduleCommandSchema.safeParse({
        name: "Bad",
        templateId: "tmpl1",
        trigger: { kind: "cron", cron: "@hourly", timeZone: "UTC" },
      }).error?.issues[0]?.message,
    ).toMatch(/Macros/);
    expect(
      createScheduleCommandSchema.safeParse({
        name: "Two\nlines",
        templateId: "tmpl1",
        trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "UTC" },
      }).success,
    ).toBe(false);
    expect(
      createScheduleCommandSchema.safeParse({
        name: "Keep",
        templateId: "tmpl1",
        trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "UTC" },
        keepWorkspaces: MAX_KEEP_WORKSPACES + 1,
      }).success,
    ).toBe(false);
    expect(
      scheduleTriggerSchema.safeParse({
        kind: "webhook",
        cron: "0 9 * * *",
        timeZone: "UTC",
      }).success,
    ).toBe(false);
  });

  it("needs at least one field in an update", () => {
    expect(updateScheduleCommandSchema.safeParse({}).success).toBe(false);
    expect(updateScheduleCommandSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });
});
