import { useState } from "react";
import { TabPanel, Tabs } from "../../components/ui";
import { ScreenHeader } from "../shell/ScreenHeader";
import { DriversPanel } from "./DriversPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ProfilesPanel } from "./ProfilesPanel";
import { SecretsPanel } from "./SecretsPanel";
import { UsagePanel } from "./UsagePanel";
import { useDrivers } from "./useDrivers";
import "./settings.css";

type Section = "models" | "secrets" | "profiles" | "drivers" | "usage";

const SECTIONS: readonly { value: Section; label: string }[] = [
  { value: "models", label: "Models" },
  { value: "secrets", label: "Secrets" },
  { value: "profiles", label: "Runtime profiles" },
  { value: "drivers", label: "Drivers" },
  { value: "usage", label: "Usage" },
];

const SECTION_KEY = "jj.settings.section";

/** The tab panel each section's tab controls. */
const panelId = (section: Section) => `settings-${section}`;

/** The last section shown, remembered per browser as a convenience only. */
function useSection(): [Section, (section: Section) => void] {
  const [section, setSection] = useState<Section>(() => {
    try {
      const stored = window.localStorage.getItem(SECTION_KEY);
      return SECTIONS.find((item) => item.value === stored)?.value ?? "models";
    } catch {
      return "models";
    }
  });
  const update = (next: Section) => {
    setSection(next);
    try {
      window.localStorage.setItem(SECTION_KEY, next);
    } catch {}
  };
  return [section, update];
}

/**
 * `#/settings` (frontend brief, "Settings"; not in the design, built in the
 * same language): models and providers with their keys, sandbox secrets,
 * runtime profiles, sandbox drivers, and usage with the spend caps.
 * Keys and secrets are write-only: typed once, sent once, never shown again.
 */
export function SettingsScreen() {
  const [section, setSection] = useSection();
  const drivers = useDrivers();
  return (
    <main className="screen settings-screen">
      <ScreenHeader
        lead={
          <>
            <h1 className="screen-title">Settings</h1>
            <span className="settings-subtitle">
              Models, secrets, runtime profiles, sandbox drivers and usage
            </span>
          </>
        }
      />
      <div className="settings-tabs">
        <Tabs
          label="Settings section"
          items={SECTIONS}
          value={section}
          onChange={setSection}
          panelId={panelId}
        />
      </div>
      <div className="settings-body">
        <TabPanel id={panelId(section)} className="settings-column">
          {section === "models" && <ModelsPanel />}
          {section === "secrets" && <SecretsPanel drivers={drivers} />}
          {section === "profiles" && <ProfilesPanel drivers={drivers} />}
          {section === "drivers" && <DriversPanel drivers={drivers} />}
          {section === "usage" && <UsagePanel />}
        </TabPanel>
      </div>
    </main>
  );
}
