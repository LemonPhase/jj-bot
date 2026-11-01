import { lazy, Suspense, useEffect, useState } from "react";
import { BotsView } from "./components/bots/BotsView";
import { NewBotModal } from "./components/modals/NewBotModal";
import { NewTaskModal } from "./components/modals/NewTaskModal";
import { TopBar } from "./components/TopBar";
import { TasksView } from "./components/tasks/TasksView";
import { useWorkspace } from "./state/WorkspaceContext";

type ModalState =
  | { kind: "none" }
  | { kind: "bot" }
  | { kind: "task"; botIds: string[] };

// Dev-only kit gallery at ?gallery=1. `import.meta.env.DEV` is false in
// production builds, so the gallery is neither bundled nor reachable there.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery").then((m) => ({ default: m.Gallery })))
  : null;
const showGallery =
  Gallery !== null &&
  new URLSearchParams(window.location.search).has("gallery");

export function App() {
  if (Gallery && showGallery)
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  return <Workspace />;
}

function Workspace() {
  const { activeTab, loading, error, dismissError, bots, selectedBotId } =
    useWorkspace();
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const openNewTask = (botIds?: string[]) => {
    const fallback = selectedBotId ?? bots[0]?.id;
    setModal({
      kind: "task",
      botIds: botIds?.length ? botIds : fallback ? [fallback] : [],
    });
  };
  const closeModal = () => setModal({ kind: "none" });

  return (
    <div className="app-shell">
      <TopBar
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={dismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading workspace…</div>
      ) : activeTab === "bots" ? (
        <BotsView
          onNewBot={() => setModal({ kind: "bot" })}
          onNewTask={openNewTask}
        />
      ) : (
        <TasksView onNewTask={() => openNewTask()} />
      )}

      {modal.kind === "bot" && <NewBotModal onClose={closeModal} />}
      {modal.kind === "task" && (
        <NewTaskModal initialBotIds={modal.botIds} onClose={closeModal} />
      )}
    </div>
  );
}
