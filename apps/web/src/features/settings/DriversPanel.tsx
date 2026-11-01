import type { SandboxDriverInfo } from "@jj/contracts";
import { useId } from "react";
import {
  Button,
  Card,
  ErrorBanner,
  Spinner,
  StatusTag,
} from "../../components/ui";
import {
  driverAvailability,
  ISOLATION_HELP,
  isolationLabel,
} from "./isolation";
import type { DriversState } from "./useDrivers";

/** Settings → Drivers: what each sandbox driver can enforce, and its probe result. */
export function DriversPanel({ drivers }: { drivers: DriversState }) {
  const headingId = useId();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          Sandbox drivers
        </h2>
        <Button onClick={drivers.reload} disabled={drivers.loading}>
          {drivers.loading ? "Checking…" : "Check again"}
        </Button>
      </div>
      <p className="settings-callout">{ISOLATION_HELP}</p>
      {drivers.error && (
        <ErrorBanner word="Error">
          Drivers did not load: {drivers.error}
        </ErrorBanner>
      )}
      {!drivers.drivers && !drivers.error && (
        <Spinner label="Loading drivers…" showLabel />
      )}
      {drivers.drivers && (
        <ul className="settings-list">
          {drivers.drivers.map((driver) => (
            <li key={driver.id}>
              <DriverCard driver={driver} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DriverCard({ driver }: { driver: SandboxDriverInfo }) {
  const availability = driverAvailability(driver);
  const { capabilities } = driver;
  const rows: [string, string][] = [
    ["Isolation", isolationLabel(capabilities.filesystemIsolation)],
    ["Network modes", capabilities.networkModes.join(", ") || "none listed"],
    [
      "Resource limits",
      capabilities.resourceLimits ? "enforced" : "not enforced",
    ],
    ["Exposed ports", capabilities.exposePort ? "yes" : "no"],
    ["Snapshots", capabilities.snapshot ? "yes" : "no"],
  ];
  return (
    <Card as="article" className="settings-card" aria-label={driver.label}>
      <div className="settings-card__head">
        <h3 className="settings-card__title">
          {driver.label}
          <code className="settings-code">{driver.id}</code>
        </h3>
        <StatusTag tone={availability.tone}>{availability.word}</StatusTag>
      </div>
      <dl className="settings-dl">
        {rows.map(([term, value]) => (
          <div key={term} className="settings-dl__row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="settings-dl__row">
          <dt>Probe</dt>
          <dd>{driver.detail ?? (driver.available ? "Passed" : "Failed")}</dd>
        </div>
      </dl>
    </Card>
  );
}
