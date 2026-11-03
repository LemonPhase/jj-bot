import type { Usage, UsageReport } from "@jj/contracts";
import { useId } from "react";
import { useApi } from "../../api/ApiContext";
import { Card, ErrorBanner, Spinner, StatusSquare } from "../../components/ui";
import { useUsageReport } from "../../state/useUsageReport";
import {
  formatCost,
  formatCount,
  spendLevel,
  spendLine,
  tokenTotal,
  unpricedNote,
} from "../tasks/format";

const calls = (usage: Usage) =>
  `${usage.modelCalls} call${usage.modelCalls === 1 ? "" : "s"}`;

const LEVEL_TONE = {
  ok: undefined,
  warning: "verifying",
  reached: "failed",
} as const;

/** " + 3 unpriced": calls whose cost is unknown, never shown as free. */
const unpricedSuffix = (usage: Usage) =>
  usage.unpricedCalls > 0 ? ` + ${usage.unpricedCalls} unpriced` : "";

/** A cost, with the calls it leaves out because their cost is unknown. */
const costText = (usage: Usage) =>
  `${formatCost(usage.costUsd)}${unpricedSuffix(usage)}`;

/** "$1.20 of $20.00", red at the cap, amber past the soft threshold. */
function SpendCell({ usage, cap }: { usage: Usage; cap: number | null }) {
  const level = spendLevel(usage.costUsd, cap);
  const tone = LEVEL_TONE[level];
  return (
    <span className="settings-spend">
      {tone && <StatusSquare tone={tone} />}
      {spendLine(usage.costUsd, cap)}
      {level === "reached" && " · cap reached"}
      {unpricedSuffix(usage)}
    </span>
  );
}

/**
 * Settings → Usage: what was spent on models over rolling windows, for the
 * whole server, per bot (direct chat apart) and per model, with the caps.
 * Calls on models with no listed price are counted apart: their cost is
 * unknown, so the totals and the caps leave them out.
 */
export function UsagePanel() {
  const api = useApi();
  const headingId = useId();
  const { report, error } = useUsageReport();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          Usage
        </h2>
      </div>
      <p className="settings-callout">
        Spend caps stop work before a model call that would go past them: a
        task's own cap, each bot's cap over any 24 hours (set in its runtime
        profile), and the server's cap over any 24 hours (
        <code className="settings-code">JJ_MAX_USD_PER_DAY</code>). They count
        model calls with a listed price only.
        {api.mode === "demo" &&
          " Demo data: these totals come from the demo tasks, and no model was called."}
      </p>
      {error && !report && (
        <ErrorBanner word="Error">Usage did not load: {error}</ErrorBanner>
      )}
      {!report && !error && <Spinner label="Loading usage…" showLabel />}
      {report && <Report report={report} />}
    </section>
  );
}

function Report({ report }: { report: UsageReport }) {
  const { instance } = report;
  const unpriced = unpricedNote(instance.last30d);
  const windows: [string, Usage][] = [
    ["Last 24 hours", instance.last24h],
    ["Last 7 days", instance.last7d],
    ["Last 30 days", instance.last30d],
  ];
  return (
    <>
      <Card as="article" className="settings-card" aria-label="All bots">
        <div className="settings-card__head">
          <h3 className="settings-card__title">Everything</h3>
        </div>
        <dl className="settings-dl">
          {windows.map(([term, usage]) => (
            <div key={term} className="settings-dl__row">
              <dt>{term}</dt>
              <dd>
                {term === "Last 24 hours" ? (
                  <SpendCell usage={usage} cap={instance.capUsdPerDay} />
                ) : (
                  costText(usage)
                )}{" "}
                · {calls(usage)} · {formatCount(tokenTotal(usage))} tokens
              </dd>
            </div>
          ))}
        </dl>
        {unpriced && <p className="settings-facts">{unpriced}.</p>}
      </Card>

      <div className="settings-table-wrap">
        <table className="settings-table settings-usage-table">
          <caption className="settings-usage-caption">Per bot</caption>
          <thead>
            <tr>
              <th scope="col">Bot</th>
              <th scope="col">Last 24 hours</th>
              <th scope="col">30 days</th>
              <th scope="col">Of it, chat</th>
            </tr>
          </thead>
          <tbody>
            {report.bots.map((bot) => (
              <tr key={bot.botId}>
                <th scope="row">
                  <span className="settings-table__name">
                    {bot.name}
                    {bot.archived && " (archived)"}
                  </span>
                </th>
                <td>
                  <SpendCell usage={bot.last24h} cap={bot.capUsdPerDay} />
                </td>
                <td>
                  {costText(bot.last30d)} · {calls(bot.last30d)}
                </td>
                <td>{costText(bot.chatLast30d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="settings-table-wrap">
        <table className="settings-table settings-usage-table">
          <caption className="settings-usage-caption">
            Per model, last 30 days
          </caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Cost</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {report.models.length === 0 && (
              <tr>
                <td colSpan={4}>No model calls in the last 30 days.</td>
              </tr>
            )}
            {report.models.map((model) => (
              <tr key={model.model}>
                <th scope="row">
                  <code className="settings-code">{model.model}</code>
                </th>
                <td>
                  {model.last30d.unpricedCalls === model.last30d.modelCalls
                    ? "no listed price"
                    : costText(model.last30d)}
                </td>
                <td>{model.last30d.modelCalls}</td>
                <td>{formatCount(tokenTotal(model.last30d))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
