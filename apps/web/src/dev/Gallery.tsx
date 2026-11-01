/**
 * Dev-only kit gallery, shown at `?gallery=1` in `vite dev` (see App.tsx).
 * Production builds never import this module.
 *
 * It renders every primitive, every sprite combination by mood, the tokens and
 * their computed contrast, in the current theme (switch at the top right).
 */
import {
  BOT_COLOURS,
  BOT_FACES,
  BOT_SHAPES,
  BOT_TOPPERS,
  type BotAppearance,
  type BotColour,
  type BotTopper,
} from "@jj/contracts";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { PixelIcon, PixelSprite } from "../components/sprite";
import {
  Avatar,
  Badge,
  Button,
  buttonClass,
  Card,
  CardButton,
  Chip,
  DayDivider,
  Dialog,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  Input,
  ListItem,
  Mention,
  ModeBadge,
  Panel,
  SectionLabel,
  Segmented,
  Select,
  Spinner,
  StatusTag,
  TabPanel,
  Tabs,
  Textarea,
  ThemeToggle,
  Tooltip,
  Wordmark,
  WorkingIndicator,
} from "../components/ui";
import {
  APPEARANCE_PRESETS,
  COLOUR_LABELS,
  FACE_LABELS,
  SHAPE_LABELS,
  TOPPER_LABELS,
} from "../lib/appearance";
import { contrastRatio } from "../lib/colour";
import {
  describeStatus,
  MOODS,
  type Mood,
  moodForStatus,
  type StatusInput,
} from "../lib/status";
import { type ThemePreference, useTheme } from "../lib/theme";
import tokensCss from "../styles/tokens.css?raw";
import "./gallery.css";

const MOOD_HEADS: Record<Mood, string> = {
  idle: "online",
  thinking: "queued",
  working: "running",
  verifying: "not used in 1.0",
  done: "completed",
  stuck: "failed",
};

const presetNamed = (name: string): BotAppearance =>
  (
    APPEARANCE_PRESETS.find((preset) => preset.name === name) ??
    APPEARANCE_PRESETS[0]
  )?.appearance as BotAppearance;

const JUNO = presetNamed("Juno");
const KITE = presetNamed("Kite");
const MOSS = presetNamed("Moss");
const VESPER = presetNamed("Vesper");

const COLOUR_TOKENS = [
  "bg-app",
  "bg-sidebar",
  "bg-surface",
  "bg-raised",
  "bg-selected",
  "bg-active",
  "bg-bubble",
  "bg-scene",
  "line-subtle",
  "line",
  "line-card",
  "line-strong",
  "line-chip-on",
  "line-steer",
  "rail",
  "graph-edge",
  "graph-dot",
  "ink",
  "ink-hover",
  "ink-2",
  "ink-3",
  "ink-muted",
  "btn-primary-bg",
  "btn-primary-ink",
  "pop-bg",
  "pop-ink",
  "pop-meta",
  "tag-bg",
  "tag-ink",
  "ping-bg",
  "ping-ink",
  "gate-frame",
];
const STATUS_TOKENS = [
  "status-running",
  "status-verifying",
  "status-completed",
  "status-failed",
  "status-idle",
  "status-running-deep",
  "status-verifying-deep",
  "status-completed-deep",
  "status-failed-ink",
];
const TEXT_TOKENS = ["ink", "ink-2", "ink-3", "ink-muted"];
const GROUND_TOKENS = [
  "bg-app",
  "bg-sidebar",
  "bg-surface",
  "bg-raised",
  "bg-selected",
  "bg-active",
  "bg-bubble",
];

/** Token values of one theme block in tokens.css (the dev table reads the source, not the DOM). */
function themeTokens(theme: "light" | "dark"): Map<string, string> {
  const marker =
    theme === "light"
      ? ':root[data-theme="light"],'
      : ':root[data-theme="dark"] {';
  const start = tokensCss.indexOf(marker);
  const body = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return new Map(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [
      match[1] as string,
      match[2] as string,
    ]),
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="gl__section" aria-label={title}>
      <SectionLabel as="h2">{title}</SectionLabel>
      {note && <p className="gl__note">{note}</p>}
      {children}
    </section>
  );
}

function Swatch({ name }: { name: string }) {
  const value =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue(`--${name}`)
          .trim();
  return (
    <div className="gl__swatch">
      <span className="gl__chip" style={{ background: `var(--${name})` }} />
      <span className="gl__swatch-text">
        <span>--{name}</span>
        <span>{value}</span>
      </span>
    </div>
  );
}

function TokensSection() {
  // Re-render on theme change so computed values refresh.
  const { resolved } = useTheme();
  return (
    <Section
      title="Colour tokens"
      note={`Computed values for the ${resolved} theme. Monochrome UI: colour only in sprites and status squares.`}
    >
      <div className="gl__grid" key={resolved}>
        {COLOUR_TOKENS.map((name) => (
          <Swatch key={name} name={name} />
        ))}
      </div>
      <div className="gl__grid" key={`${resolved}-status`}>
        {STATUS_TOKENS.map((name) => (
          <Swatch key={name} name={name} />
        ))}
      </div>
      <div className="gl__row">
        {BOT_COLOURS.map((colour) => (
          <Mention key={colour} colour={colour}>
            @{COLOUR_LABELS[colour]}
          </Mention>
        ))}
      </div>
    </Section>
  );
}

function ContrastSection() {
  const tables = useMemo(
    () =>
      (["light", "dark"] as const).map((theme) => {
        const tokens = themeTokens(theme);
        return {
          theme,
          rows: TEXT_TOKENS.map((text) => ({
            text,
            ratios: GROUND_TOKENS.map((ground) =>
              contrastRatio(
                tokens.get(text) ?? "#000",
                tokens.get(ground) ?? "#000",
              ),
            ),
          })),
        };
      }),
    [],
  );
  return (
    <Section
      title="Text contrast"
      note="WCAG ratios computed from tokens.css for both themes. Every pair must reach 4.5:1 (tokens.test.ts enforces it)."
    >
      <div className="gl__cols">
        {tables.map(({ theme, rows }) => (
          <table className="gl__table" key={theme}>
            <caption className="visually-hidden">
              {theme} theme contrast
            </caption>
            <thead>
              <tr>
                <th>{theme}</th>
                {GROUND_TOKENS.map((ground) => (
                  <th key={ground}>{ground.replace("bg-", "")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.text}>
                  <td>--{row.text}</td>
                  {row.ratios.map((ratio, index) => (
                    <td className="gl__num" key={GROUND_TOKENS[index]}>
                      {ratio.toFixed(2)}
                      {ratio < 4.5 ? " fail" : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </Section>
  );
}

function TypeSection() {
  const sample = (
    label: string,
    style: CSSProperties,
    text = "Verify SSE event stream replay",
  ) => (
    <div className="gl__swatch-text" key={label}>
      <span style={style}>{text}</span>
      <span>{label}</span>
    </div>
  );
  return (
    <Section title="Type">
      <div className="gl__cols">
        <div className="gl__section">
          {sample(
            "Geist 600 · 26 · System title",
            {
              fontSize: "var(--fs-display)",
              fontWeight: 600,
              letterSpacing: "var(--tracking-title)",
            },
            "What can Juno help with?",
          )}
          {sample(
            "Geist 600 · 22 · About name",
            {
              fontSize: "var(--fs-title-lg)",
              fontWeight: 600,
              letterSpacing: "var(--tracking-title)",
            },
            "Juno",
          )}
          {sample("Geist 600 · 15 · page title", {
            fontSize: "var(--fs-title)",
            fontWeight: 600,
          })}
          {sample(
            "Geist 400 · 14 / 1.5 · body",
            { fontSize: "var(--fs-body)" },
            "Keep the payload schema unchanged while doing that.",
          )}
          {sample("Geist 500 · 13.5 · list title", {
            fontSize: "var(--fs-list-title)",
            fontWeight: 500,
          })}
          {sample("Geist 400 · 13 · brief (ink-2)", {
            fontSize: "var(--fs-ui)",
            color: "var(--ink-2)",
          })}
        </div>
        <div className="gl__section">
          {sample(
            "Geist Mono 400 · 12 · header status",
            {
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-small)",
              color: "var(--ink-muted)",
            },
            "running · v2 · 05:20 PM",
          )}
          {sample(
            "Geist Mono 400 · 11.5 · tool line (ink-3)",
            {
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-mono)",
              color: "var(--ink-3)",
            },
            "edit_file(routes.ts) → run_test(backend.test.ts)",
          )}
          {sample(
            "Geist Mono 400 · 11 · section label",
            {
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-mono-sm)",
              letterSpacing: "var(--tracking-label)",
              color: "var(--ink-muted)",
            },
            "BOTS · TASKS · TODAY",
          )}
          {sample(
            "Silkscreen 400 · 16 · wordmark only",
            {
              fontFamily: "var(--font-pixel)",
              fontSize: "16px",
              letterSpacing: "var(--tracking-wordmark)",
            },
            "JJ BOT",
          )}
          <div className="gl__row">
            <span className="gl__pop">Pop overlay · --shadow-pixel</span>
            <span className="clamp1" style={{ maxWidth: 180 }}>
              .clamp1 truncates a long line with an ellipsis
            </span>
          </div>
        </div>
      </div>
      <div className="gl__row">
        {["xs", "sm", "md", "lg", "xl", "composer", "pill"].map((radius) => (
          <span
            key={radius}
            className="gl__radius"
            style={{ borderRadius: `var(--r-${radius})` }}
          >
            {radius}
          </span>
        ))}
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((step) => (
          <span
            key={step}
            className="gl__space"
            style={{ width: `var(--sp-${step})` }}
            title={`--sp-${step}`}
          />
        ))}
      </div>
    </Section>
  );
}

function ButtonsSection() {
  const [steer, setSteer] = useState(false);
  const [profile, setProfile] = useState(true);
  const [playing, setPlaying] = useState(false);
  return (
    <Section
      title="Buttons"
      note="Pills: primary, secondary, ghost, danger (the Stop pill) at sm 28 / md 30 / lg 32. Toggle pills use aria-pressed (steer). Disabled is 40% opacity."
    >
      {(["sm", "md", "lg"] as const).map((size) => (
        <div className="gl__row" key={size}>
          <Button variant="primary" size={size}>
            New task
          </Button>
          <Button size={size}>New task</Button>
          <Button variant="ghost" size={size}>
            ← Bots
          </Button>
          <Button variant="danger" size={size}>
            Stop
          </Button>
          <Button variant="primary" size={size} disabled>
            Create bot
          </Button>
          <Button size={size} disabled>
            Cancel
          </Button>
        </div>
      ))}
      <div className="gl__row">
        <Button size="lg" mono pressed={steer} onClick={() => setSteer(!steer)}>
          steer
        </Button>
        <Button size="sm" mono>
          turntable on
        </Button>
        <Button size="md" mono style={{ padding: "0 10px" }}>
          1×
        </Button>
        <a className={buttonClass({ variant: "secondary" })} href="#gallery">
          Link styled as a pill
        </a>
      </div>
      <div className="gl__row">
        <IconButton label="New bot" icon={<Icon name="plus" />} tone="ink" />
        <IconButton
          label="New bot (current page)"
          icon={<Icon name="plus" />}
          tone="ink"
          current
        />
        <IconButton
          label="Profile"
          icon={<Icon name="panel" size={17} />}
          pressed={profile}
          onClick={() => setProfile(!profile)}
        />
        <ThemeToggle />
        <IconButton
          label="Send"
          variant="primary"
          size="lg"
          icon={<Icon name="send" />}
        />
        <IconButton
          label="Send"
          variant="primary"
          size="lg"
          icon={<Icon name="send" />}
          disabled
        />
        <IconButton
          label={playing ? "Pause" : "Play"}
          variant="primary"
          icon={<PixelIcon name={playing ? "pause" : "play"} size={12} />}
          onClick={() => setPlaying(!playing)}
        />
        <IconButton
          label="Open task"
          icon={<Icon name="arrow-right" size={15} />}
        />
      </div>
    </Section>
  );
}

function ControlsSection() {
  const [nav, setNav] = useState<"bots" | "tasks">("bots");
  const [motion, setMotion] = useState<"idle" | "walk" | "talk" | "work">(
    "walk",
  );
  const [dim, setDim] = useState<"2d" | "3d">("2d");
  const [view, setView] = useState<"progress" | "graph" | "office">("progress");
  const [shape, setShape] = useState<BotAppearance["shape"]>("dome");
  return (
    <Section title="Segmented, tabs and chips">
      <div className="gl__row gl__row--top">
        <div style={{ width: 236 }}>
          <Segmented
            label="Primary"
            kind="nav"
            value={nav}
            onChange={setNav}
            options={[
              { value: "bots", label: "Bots", count: 4 },
              { value: "tasks", label: "Tasks", count: 3 },
            ]}
          />
        </div>
        <div style={{ minWidth: 300 }}>
          <Segmented
            label="Preview motion"
            variant="compact"
            value={motion}
            onChange={setMotion}
            options={[
              { value: "idle", label: "Idle" },
              { value: "walk", label: "Walk" },
              { value: "talk", label: "Talk" },
              { value: "work", label: "Work" },
            ]}
          />
        </div>
        <Segmented
          label="Office view"
          variant="mono"
          value={dim}
          onChange={setDim}
          options={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
        />
        <div className="gl__section">
          <Tabs
            label="View"
            value={view}
            onChange={setView}
            panelId={(value) => `gallery-view-${value}`}
            items={[
              { value: "progress", label: "Progress" },
              { value: "graph", label: "Graph" },
              { value: "office", label: "Office" },
            ]}
          />
          <TabPanel id={`gallery-view-${view}`} className="gl__meta">
            {view} panel
          </TabPanel>
        </div>
      </div>
      <div className="gl__row gl__row--tight">
        {BOT_SHAPES.map((value) => (
          <Chip
            key={value}
            selected={shape === value}
            onClick={() => setShape(value)}
            leading={
              <PixelSprite
                appearance={{
                  shape: value,
                  face: "dots",
                  topper: "none",
                  colour: "teal",
                }}
                size={14}
              />
            }
          >
            {SHAPE_LABELS[value]}
          </Chip>
        ))}
        <Chip selected={false} disabled>
          Disabled
        </Chip>
      </div>
    </Section>
  );
}

function FieldsSection() {
  const [name, setName] = useState("Juno");
  const [colour, setColour] = useState<BotColour>("coral");
  return (
    <Section title="Fields">
      <div className="gl__cols">
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint="Shown in lists and @mentions."
        />
        <Input label="Role" placeholder="Coordinator · Systems Architect" />
        <Input
          label="Image"
          note="docker"
          defaultValue="node:22"
          error="PROFILE_UNSUPPORTED: the docker driver is not available on this host."
        />
        <Select
          label="Colour"
          value={colour}
          onChange={setColour}
          options={BOT_COLOURS.map((value) => ({
            value,
            label: COLOUR_LABELS[value],
          }))}
        />
        <Textarea
          label="Instructions"
          placeholder="Decompose user goals into crisp execution briefs…"
        />
        <Input
          label="API key"
          disabled
          value="Set ANTHROPIC_API_KEY on the server"
          readOnly
        />
      </div>
    </Section>
  );
}

const STATUS_ROWS: Array<{ label: string; input: StatusInput }> = [
  { label: "bot presence idle", input: "idle" },
  { label: "bot presence working", input: "working" },
  { label: "queued", input: "queued" },
  { label: "running", input: "running" },
  { label: "waiting (task)", input: "waiting" },
  {
    label: "waiting for user",
    input: { status: "waiting", waitingFor: "user" },
  },
  {
    label: "waiting on delegations",
    input: { status: "waiting", waitingFor: "delegations" },
  },
  { label: "completed", input: "completed" },
  { label: "failed", input: "failed" },
  { label: "cancelled", input: "cancelled" },
  {
    label: "stop requested",
    input: { status: "running", cancelRequestedAt: "2026-10-31T12:00:00Z" },
  },
];

function StatusSection() {
  return (
    <Section
      title="Status"
      note="One vocabulary (brief decisions 1 and 2): the word, its square and the sprite mood. Waiting carries a tooltip from waitingFor."
    >
      <table className="gl__table">
        <thead>
          <tr>
            <th>value</th>
            <th>tag (lg / md / sm / sans)</th>
            <th>mood</th>
            <th>title</th>
          </tr>
        </thead>
        <tbody>
          {STATUS_ROWS.map(({ label, input }) => {
            const display = describeStatus(input);
            return (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  <span className="gl__row">
                    <StatusTag status={input} size="lg" />
                    <StatusTag status={input} detail="Juno" />
                    <StatusTag status={input} size="sm" />
                    <StatusTag status={input} size="sans" />
                  </span>
                </td>
                <td>
                  <span className="gl__row gl__row--tight">
                    <PixelSprite
                      appearance={JUNO}
                      mood={moodForStatus(input)}
                      size={24}
                    />
                    <span className="gl__meta">{display.mood}</span>
                  </span>
                </td>
                <td className="gl__meta">{display.title ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="gl__row">
        <Badge>Demo data</Badge>
        <Badge tone="completed">live</Badge>
        <Badge tone="idle">replaying</Badge>
        <Badge variant="step">3 / 7</Badge>
        <ModeBadge kind="demo" />
        <ModeBadge kind="live" />
        <ModeBadge kind="no-model" />
        <ModeBadge kind="scripted" />
        <StatusTag tone="completed">passed</StatusTag>
        <StatusTag tone="failed">failed</StatusTag>
        <StatusTag tone="idle">inconclusive</StatusTag>
      </div>
    </Section>
  );
}

function ListsSection() {
  const [selectedBot, setSelectedBot] = useState("Juno");
  const [selectedTask, setSelectedTask] = useState(0);
  const bots: Array<{
    name: string;
    appearance: BotAppearance;
    mood: Mood;
    tone: "running" | "idle" | "verifying";
    line: string;
  }> = [
    {
      name: "Juno",
      appearance: JUNO,
      mood: "working",
      tone: "running",
      line: "Coordinating · 3 sessions",
    },
    {
      name: "Kite",
      appearance: KITE,
      mood: "idle",
      tone: "idle",
      line: "Idle",
    },
    {
      name: "Moss",
      appearance: MOSS,
      mood: "working",
      tone: "running",
      line: "Working on Replay patch",
    },
    {
      name: "Vesper",
      appearance: VESPER,
      mood: "idle",
      tone: "idle",
      line: "Waiting for you",
    },
  ];
  const tasks: Array<{
    goal: string;
    status: StatusInput;
    version: number;
    who: Array<[BotAppearance, Mood]>;
  }> = [
    {
      goal: "Verify SSE event stream replay & cursor resume",
      status: "running",
      version: 2,
      who: [
        [JUNO, "working"],
        [MOSS, "working"],
        [VESPER, "thinking"],
      ],
    },
    {
      goal: "Benchmark worker queue lease recovery under timeout",
      status: "queued",
      version: 1,
      who: [
        [JUNO, "thinking"],
        [MOSS, "thinking"],
      ],
    },
    {
      goal: "Consolidate v0.2 contract schemas across packages",
      status: "completed",
      version: 1,
      who: [
        [KITE, "done"],
        [VESPER, "done"],
      ],
    },
  ];
  return (
    <Section title="Sidebar rows">
      <div className="gl__row gl__row--top">
        <aside className="gl__sidebar" aria-label="Navigation (sample)">
          <div className="gl__brand-row">
            <Wordmark />
            <IconButton
              label="New bot"
              icon={<Icon name="plus" />}
              tone="ink"
            />
          </div>
          <Segmented
            label="Primary"
            kind="nav"
            value="bots"
            onChange={() => {}}
            options={[
              { value: "bots", label: "Bots", count: 4 },
              { value: "tasks", label: "Tasks", count: 3 },
            ]}
          />
          <div className="ui-list">
            <SectionLabel className="gl__list-label">Bots</SectionLabel>
            {bots.map((bot) => (
              <ListItem
                key={bot.name}
                pressed={selectedBot === bot.name}
                onClick={() => setSelectedBot(bot.name)}
                leading={
                  <Avatar
                    appearance={bot.appearance}
                    name={bot.name}
                    mood={bot.mood}
                    size={36}
                    decorative
                  />
                }
                title={bot.name}
                subtitle={
                  <StatusTag size="sans" tone={bot.tone}>
                    {bot.line}
                  </StatusTag>
                }
              />
            ))}
          </div>
          <div className="gl__footer-row">
            <ModeBadge kind="demo" />
            <ThemeToggle />
          </div>
        </aside>
        <aside className="gl__sidebar" aria-label="Tasks (sample)">
          <div className="ui-list">
            <SectionLabel className="gl__list-label">Tasks</SectionLabel>
            {tasks.map((task, index) => (
              <ListItem
                key={task.goal}
                layout="stack"
                pressed={selectedTask === index}
                muted={task.status === "completed"}
                onClick={() => setSelectedTask(index)}
                title={task.goal}
                subtitle={
                  <StatusTag status={task.status} detail={`v${task.version}`} />
                }
                trailing={
                  <span className="gl__participants">
                    {task.who.map(([appearance, mood], i) => (
                      <PixelSprite
                        key={`${appearance.shape}-${appearance.colour}-${mood}-${i}`}
                        appearance={appearance}
                        mood={mood}
                        size={24}
                      />
                    ))}
                  </span>
                }
              />
            ))}
            <EmptyState
              message="No tasks yet."
              action={<Button variant="primary">New task</Button>}
            />
          </div>
        </aside>
      </div>
    </Section>
  );
}

function CardsSection() {
  const [selected, setSelected] = useState("s-2");
  return (
    <Section title="Cards, panel and chat pieces">
      <div className="gl__cols">
        <Card as="section" aria-label="Selected session">
          <div className="gl__row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: "var(--fs-list-title)", fontWeight: 500 }}>
              s-2 · Replay patch{" "}
              <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>
                · Moss
              </span>
            </span>
            <StatusTag status="running" />
          </div>
          <p className="gl__card-brief">
            Ensure /tasks/:id/stream resumes strictly after sequence cursor
            without duplicate emissions.
          </p>
          <span className="gl__card-tools">
            edit_file(routes.ts) → run_test(backend.test.ts)
          </span>
          <span className="gl__card-evidence">
            Evidence · Streaming 14 events in order
          </span>
        </Card>
        <div className="gl__row gl__row--top" style={{ flexWrap: "nowrap" }}>
          {[
            {
              id: "s-2",
              title: "Replay patch",
              who: MOSS,
              status: "running" as const,
            },
            {
              id: "s-3",
              title: "QA Gate",
              who: VESPER,
              status: "waiting" as const,
            },
          ].map((node) => (
            <CardButton
              key={node.id}
              density="compact"
              pressed={selected === node.id}
              onClick={() => setSelected(node.id)}
            >
              <span
                className="gl__row"
                style={{ justifyContent: "space-between", gap: 6 }}
              >
                <PixelSprite
                  appearance={node.who}
                  mood={moodForStatus(node.status)}
                  size={24}
                />
                <StatusTag status={node.status} size="sm" />
              </span>
              <span
                style={{
                  fontSize: "var(--fs-ui)",
                  fontWeight: 500,
                  lineHeight: 1.3,
                }}
              >
                {node.id} · {node.title}
              </span>
              <span
                className="gl__meta"
                style={{ fontSize: "var(--fs-mono-sm)" }}
              >
                2 tools
              </span>
            </CardButton>
          ))}
        </div>
        <Panel label="Progress (sample)" as="section" className="gl__box">
          <Tabs
            label="View"
            value="progress"
            onChange={() => {}}
            items={[
              { value: "progress", label: "Progress" },
              { value: "graph", label: "Graph" },
            ]}
          />
          <div className="gl__row gl__row--tight">
            <span className="ui-sprite-tile">
              <PixelIcon name="gate" size={24} />
            </span>
            <span>Verification</span>
            <span className="gl__meta">1/2 checks passed</span>
          </div>
        </Panel>
        <div className="gl__section">
          <DayDivider>Today</DayDivider>
          <div className="gl__message">
            <span className="gl__author">
              <PixelSprite appearance={JUNO} size={24} />
              Juno <span className="gl__meta">assignment · 05:17 PM</span>
            </span>
            <p>
              <Mention colour="green">@Moss</Mention> take session s-2 to test
              cursor boundary conditions.{" "}
              <Mention colour="violet">@Vesper</Mention> prepare reconnect
              verification. <Mention colour="amber">@Amber</Mention>{" "}
              <Mention colour="blue">@Kite</Mention>
            </p>
          </div>
          <WorkingIndicator name="Juno" appearance={JUNO} />
        </div>
      </div>
    </Section>
  );
}

function FeedbackSection() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(true);
  return (
    <Section title="Feedback, tooltip, dialog, avatars">
      <div className="gl__cols">
        <div className="gl__section">
          <EmptyState
            align="center"
            illustration={<PixelSprite appearance={KITE} size={48} />}
            message="No messages with Kite yet."
            action={<Button variant="primary">Message Kite</Button>}
          />
          <div className="gl__row">
            <Spinner />
            <Spinner showLabel />
          </div>
          {error ? (
            <ErrorBanner
              word="PROFILE_UNSUPPORTED"
              onDismiss={() => setError(false)}
            >
              The docker driver cannot enforce network mode "none" on this host.
            </ErrorBanner>
          ) : (
            <Button onClick={() => setError(true)}>Show error banner</Button>
          )}
        </div>
        <div className="gl__section">
          <div className="gl__row">
            <StatusTag
              status={{ status: "waiting", waitingFor: "delegations" }}
              focusableTooltip
            />
            <Tooltip content="Switch the office between 2D and 3D">
              <Button size="sm">Hover or focus me</Button>
            </Tooltip>
            <Tooltip content="Below the trigger" placement="bottom">
              <Button size="sm">Below</Button>
            </Tooltip>
            <IconButton
              label="Profile"
              icon={<Icon name="panel" size={17} />}
            />
          </div>
          <div className="gl__row">
            <Button variant="primary" onClick={() => setOpen(true)}>
              Open dialog
            </Button>
          </div>
          <div className="gl__row" style={{ alignItems: "flex-end" }}>
            {[24, 36, 48, 60].map((size) => (
              <Avatar key={size} appearance={MOSS} name="Moss" size={size} />
            ))}
            {[24, 36, 48].map((size) => (
              <Avatar key={`f${size}`} name="Deleted bot" size={size} />
            ))}
          </div>
          <div className="gl__row">
            <PixelIcon name="brand" size={20} label="JJ Bot" />
            <PixelIcon name="brand" size={30} />
            <PixelIcon name="gate" size={24} />
            <Wordmark />
            <Wordmark markSize={30} />
          </div>
        </div>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete runtime profile?"
        description="Bots using it fall back to the default profile."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Delete
            </Button>
          </>
        }
      >
        <Input
          label="Type the profile name to confirm"
          placeholder="docker-default"
        />
      </Dialog>
    </Section>
  );
}

function SpriteRow({
  label,
  sub,
  appearance,
  size,
}: {
  label: string;
  sub: string;
  appearance:
    | BotAppearance
    | Pick<BotAppearance, "shape" | "face" | "topper" | "colour">;
  size: number;
}) {
  return (
    <>
      <span className="gl__row-label">
        <span>{label}</span>
        <span>{sub}</span>
      </span>
      {MOODS.map((mood) => (
        <PixelSprite
          key={mood}
          appearance={appearance}
          mood={mood}
          size={size}
        />
      ))}
    </>
  );
}

function MoodHeads() {
  return (
    <>
      <span />
      {MOODS.map((mood) => (
        <span className="gl__mood-head" key={mood}>
          <span>{mood[0]?.toUpperCase() + mood.slice(1)}</span>
          <span>{MOOD_HEADS[mood]}</span>
        </span>
      ))}
    </>
  );
}

function SpritesSection() {
  const [topper, setTopper] = useState<BotTopper>("antenna");
  const [colour, setColour] = useState<BotColour>("teal");
  const [everything, setEverything] = useState(false);
  return (
    <Section
      title="Sprites · 12 × 12 grid · moods"
      note="Moods follow the System sheet's rule on every combination (bottom eye row 6). Working bobs; reduced motion stops it. Verifying exists but no 1.0 status maps to it."
    >
      <div className="gl__sprites">
        <MoodHeads />
        {APPEARANCE_PRESETS.map((preset) => (
          <SpriteRow
            key={preset.name}
            label={preset.name}
            sub={`${preset.appearance.shape} · ${preset.appearance.face} · ${preset.appearance.topper}`}
            appearance={preset.appearance}
            size={48}
          />
        ))}
      </div>

      <SectionLabel tracking="part">Every shape × face, by mood</SectionLabel>
      <div className="gl__row">
        <div style={{ width: 200 }}>
          <Select
            label="Topper"
            value={topper}
            onChange={setTopper}
            options={BOT_TOPPERS.map((value) => ({
              value,
              label: TOPPER_LABELS[value],
            }))}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label="Colour"
            value={colour}
            onChange={setColour}
            options={BOT_COLOURS.map((value) => ({
              value,
              label: COLOUR_LABELS[value],
            }))}
          />
        </div>
      </div>
      <div className="gl__sprites gl__sprites--dense">
        <MoodHeads />
        {BOT_SHAPES.flatMap((shape) =>
          BOT_FACES.map((face) => (
            <SpriteRow
              key={`${shape}-${face}`}
              label={`${SHAPE_LABELS[shape]} · ${FACE_LABELS[face]}`}
              sub={`${TOPPER_LABELS[topper]} · ${COLOUR_LABELS[colour]}`}
              appearance={{ shape, face, topper, colour }}
              size={36}
            />
          )),
        )}
      </div>

      <SectionLabel tracking="part">Every topper and colour</SectionLabel>
      <div className="gl__sprites gl__sprites--dense">
        <MoodHeads />
        {BOT_TOPPERS.map((value, index) => (
          <SpriteRow
            key={value}
            label={TOPPER_LABELS[value]}
            sub={
              COLOUR_LABELS[
                BOT_COLOURS[index % BOT_COLOURS.length] as BotColour
              ]
            }
            appearance={{
              shape: BOT_SHAPES[index % BOT_SHAPES.length] ?? "squircle",
              face: BOT_FACES[index % BOT_FACES.length] ?? "dots",
              topper: value,
              colour: BOT_COLOURS[index % BOT_COLOURS.length] ?? "coral",
            }}
            size={36}
          />
        ))}
      </div>
      <div className="gl__row">
        {BOT_COLOURS.map((value) => (
          <span className="gl__swatch" key={value}>
            <PixelSprite
              appearance={{
                shape: "squircle",
                face: "visor",
                topper: "antenna",
                colour: value,
              }}
              size={36}
            />
            <span className="gl__meta">{COLOUR_LABELS[value]}</span>
          </span>
        ))}
      </div>
      <div className="gl__row" style={{ alignItems: "flex-end" }}>
        {[12, 14, 24, 36, 48, 60, 96].map((size) => (
          <PixelSprite
            key={size}
            appearance={presetNamed("Teal Dome")}
            mood="working"
            size={size}
          />
        ))}
      </div>

      <div className="gl__row">
        <Button onClick={() => setEverything(!everything)} pressed={everything}>
          {everything ? "Hide" : "Show"} all 1,120 appearances × 6 moods
        </Button>
      </div>
      {everything &&
        MOODS.map((mood) => (
          <div className="gl__section" key={mood}>
            <SectionLabel tracking="part">{mood}</SectionLabel>
            <div className="gl__all">
              {BOT_SHAPES.flatMap((shape) =>
                BOT_FACES.flatMap((face) =>
                  BOT_TOPPERS.flatMap((top) =>
                    BOT_COLOURS.map((col) => (
                      <PixelSprite
                        key={`${shape}${face}${top}${col}`}
                        appearance={{ shape, face, topper: top, colour: col }}
                        mood={mood}
                        size={24}
                        animate={false}
                      />
                    )),
                  ),
                ),
              )}
            </div>
          </div>
        ))}
    </Section>
  );
}

export function Gallery() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="gl" id="gallery">
      <div className="gl__inner">
        <header className="gl__header">
          <div className="gl__title">
            <PixelIcon name="brand" size={30} />
            <h1>Pixel Lite · UI kit</h1>
          </div>
          <div className="gl__row">
            <span className="gl__meta">dev gallery · ?gallery=1</span>
            <div style={{ width: 240 }}>
              <Segmented<ThemePreference>
                label="Theme"
                variant="compact"
                value={preference}
                onChange={setPreference}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </div>
            <ThemeToggle />
          </div>
        </header>
        <TokensSection />
        <ContrastSection />
        <TypeSection />
        <ButtonsSection />
        <ControlsSection />
        <FieldsSection />
        <StatusSection />
        <ListsSection />
        <CardsSection />
        <FeedbackSection />
        <SpritesSection />
      </div>
    </div>
  );
}
