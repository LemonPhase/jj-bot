import { useState } from "react";
import { TabPanel, Tabs } from "../../components/ui";
import { ScreenHeader } from "../shell/ScreenHeader";
import { DriversPanel } from "./DriversPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ProfilesPanel } from "./ProfilesPanel";
import { useDrivers } from "./useDrivers";
import "./settings.css";

type Section = "models" | "profiles" | "drivers";

const SECTIONS: readonly { value: Section; label: string }[] = [
  { value: "models", label: "Models" },
  { value: "profiles", label: "Runtime profiles" },
  { value: "drivers", label: "Drivers" },
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
 * same language): models and providers, runtime profiles, sandbox drivers.
 * Keys never pass through here: providers are enabled by server env vars.
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
              Models, runtime profiles and sandbox drivers
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
          {section === "profiles" && <ProfilesPanel drivers={drivers} />}
          {section === "drivers" && <DriversPanel drivers={drivers} />}
        </TabPanel>
      </div>
    </main>
  );
}
