import { buttonClass, EmptyState } from "../../components/ui";
import { botHref } from "../shell/router";
import { ScreenHeader } from "../shell/ScreenHeader";

/**
 * `#/settings`. Route stub: the Settings screen (models and runtime profiles,
 * frontend brief "Settings") replaces this.
 */
export function SettingsScreen() {
  return (
    <main className="screen">
      <ScreenHeader lead={<h1 className="screen-title">Settings</h1>} />
      <div className="screen-body screen-body--center">
        <EmptyState
          align="center"
          message="Settings are not available yet."
          action={
            <a
              className={buttonClass({ variant: "primary" })}
              href={botHref(null)}
            >
              Back to bots
            </a>
          }
        />
      </div>
    </main>
  );
}
