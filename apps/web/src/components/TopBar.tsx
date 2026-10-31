import { useApi } from "../api/ApiContext";
import { type MainTab, useWorkspace } from "../state/WorkspaceContext";

const TABS: { id: MainTab; label: string }[] = [
  { id: "bots", label: "Bots" },
  { id: "tasks", label: "Tasks" },
];

export function TopBar({ onToggleTheme }: { onToggleTheme: () => void }) {
  const api = useApi();
  const { activeTab, setActiveTab, bots, tasks } = useWorkspace();
  const counts: Record<MainTab, number> = {
    bots: bots.length,
    tasks: tasks.length,
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">jj</span>
        <span>JJ Bot</span>
      </div>

      <nav className="main-tabs" aria-label="Primary tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`main-tab ${activeTab === tab.id ? "active" : ""}`}
            aria-current={activeTab === tab.id ? "page" : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <span className="tab-count">{counts[tab.id]}</span>
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <span
          className={`mode-badge ${api.badge.tone}`}
          title={api.badge.title}
        >
          {api.badge.label}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          ◐
        </button>
      </div>
    </header>
  );
}
