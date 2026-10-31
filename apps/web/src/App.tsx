import { type Bootstrap, bootstrapSchema } from "@jj/contracts";
import { useEffect, useState } from "react";

const sections = ["Overview", "Bots", "Tasks", "Runtime"] as const;
type Section = (typeof sections)[number];
const notion = "https://app.notion.com/p/44ef1321420182e4acb781ba075ad9b0";

export function App() {
  const [section, setSection] = useState<Section>("Overview");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setBootstrap(null);
    fetch(`/api/bootstrap?attempt=${attempt}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        return bootstrapSchema.parse(await response.json());
      })
      .then(setBootstrap)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "API unavailable",
          );
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="JJ Bot home">
          <span className="brand-mark">jj</span>
          <span>
            JJ BOT<small>YOUR AGENT WORKSPACE</small>
          </span>
        </a>
        <div className="workspace-label">
          HALLOWEEN HACKATHON <span>01</span>
        </div>
        <nav aria-label="Workspace">
          {sections.map((item, index) => (
            <button
              key={item}
              type="button"
              className={section === item ? "nav-item active" : "nav-item"}
              aria-current={section === item ? "page" : undefined}
              onClick={() => setSection(item)}
            >
              <span className="nav-number">0{index + 1}</span>
              {item}
              <span className="nav-arrow">↗</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-label">THE WORKING MODEL</span>
          <p>
            Persistent bots.
            <br />
            Shared goals.
            <br />
            Work you can follow.
          </p>
          <a href={notion} target="_blank" rel="noreferrer">
            Open team context ↗
          </a>
        </div>
        <div className="sidebar-footer">
          <span className="status-dot" /> DEVELOPMENT SCAFFOLD
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> {section}
          </span>
          <a
            href="https://github.com/LemonPhase/jj-bot"
            target="_blank"
            rel="noreferrer"
          >
            Repository ↗
          </a>
        </header>
        <div className="content">
          <div className="eyebrow">
            <span className="status-dot" /> FRONTIER AGENTS · GEMINI
          </div>
          <div className="page-title">
            <h1>
              {section === "Overview" ? (
                <>
                  A place for agents
                  <br />
                  to work together.
                </>
              ) : section === "Bots" ? (
                "Your persistent team."
              ) : section === "Tasks" ? (
                "One goal. Many contributors."
              ) : (
                "The execution foundation."
              )}
            </h1>
            <span className="edition">
              JJ / 001
              <br />
              FOUNDATION
            </span>
          </div>
          <p className="intro">
            {section === "Overview"
              ? "Delegate a goal, follow the collaboration, and steer the work. This is the starting point for JJ Bot."
              : section === "Bots"
                ? "Each bot will keep its own identity and scoped memory, contributing to multiple tasks through independent sessions."
                : section === "Tasks"
                  ? "A task brings bots, execution sessions, shared conversation, and verification together around one problem."
                  : "Application-owned infrastructure, CopilotKit OSS integration, and direct Google GenAI SDK execution."}
          </p>
          <div className="connection" role="status">
            <span
              className={`status-dot ${error ? "error" : !bootstrap ? "pending" : ""}`}
            />
            <strong>
              {error
                ? "API unavailable"
                : bootstrap
                  ? "API connected"
                  : "Connecting to API…"}
            </strong>
            <span>
              {error ??
                (bootstrap
                  ? `Contract ${bootstrap.contractVersion} · scaffold mode`
                  : "Checking the local application backend")}
            </span>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Check again ↻
            </button>
          </div>
          {section === "Overview" ? (
            <>
              <section
                className="foundation"
                aria-labelledby="foundation-title"
              >
                <div className="panel-heading">
                  <h2 id="foundation-title">The foundation is here.</h2>
                  <span className="badge">SCAFFOLD</span>
                </div>
                <p>
                  The workspace shell and integration boundaries are ready.
                  Agent execution, durable tasks, and live collaboration are the
                  next workstreams.
                </p>
                <div className="architecture">
                  <div>
                    <span>01</span>
                    <h3>Bots</h3>
                    <p>Identity & scoped memory</p>
                  </div>
                  <b aria-hidden="true">→</b>
                  <div>
                    <span>02</span>
                    <h3>Tasks</h3>
                    <p>A goal & shared context</p>
                  </div>
                  <b aria-hidden="true">→</b>
                  <div>
                    <span>03</span>
                    <h3>Sessions</h3>
                    <p>Execute, verify, revise</p>
                  </div>
                </div>
              </section>
              <div className="section-heading">
                <h2>Start building</h2>
                <span>THREE CONNECTED LAYERS</span>
              </div>
              <div className="cards">
                <button type="button" onClick={() => setSection("Bots")}>
                  <span className="card-index">01 / PERSONAS</span>
                  <h3>
                    Build the team <span className="card-arrow">↗</span>
                  </h3>
                  <p>
                    Persistent identities with deliberate context boundaries.
                  </p>
                </button>
                <button type="button" onClick={() => setSection("Tasks")}>
                  <span className="card-index">02 / COORDINATION</span>
                  <h3>
                    Make work visible <span className="card-arrow">↗</span>
                  </h3>
                  <p>Shared tasks, attributed contributions, and steering.</p>
                </button>
                <button type="button" onClick={() => setSection("Runtime")}>
                  <span className="card-index">03 / EXECUTION</span>
                  <h3>
                    Close the loop <span className="card-arrow">↗</span>
                  </h3>
                  <p>Independent sessions with evidence-backed checks.</p>
                </button>
              </div>
            </>
          ) : section === "Runtime" ? (
            <section className="foundation">
              <div className="panel-heading">
                <h2>Connection boundaries</h2>
                <span className="badge">NOT EXECUTING</span>
              </div>
              <dl className="runtime-list">
                <div>
                  <dt>Application API</dt>
                  <dd>{bootstrap ? "Connected · Hono" : "Waiting for API"}</dd>
                </div>
                <div>
                  <dt>Frontend integration</dt>
                  <dd>CopilotKit OSS / AG-UI</dd>
                </div>
                <div>
                  <dt>Google model configuration</dt>
                  <dd>
                    {bootstrap?.modelConfigured
                      ? "Present · live access untested"
                      : "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt>Session executor</dt>
                  <dd>Not implemented</dd>
                </div>
                <div>
                  <dt>Persistence & job queue</dt>
                  <dd>Not implemented</dd>
                </div>
              </dl>
              <p>No model calls or background tasks run in this scaffold.</p>
            </section>
          ) : (
            <section className="foundation empty">
              <span className="empty-symbol" aria-hidden="true">
                {section === "Bots" ? "◎" : "⌘"}
              </span>
              <h2>
                {section === "Bots"
                  ? "No bots configured yet."
                  : "No tasks created yet."}
              </h2>
              <p>
                {section === "Bots"
                  ? "Bot creation and persistence are a dedicated follow-up workstream."
                  : "Task creation, group chat, and execution sessions will connect here."}
              </p>
              <a
                className="context-button"
                href={notion}
                target="_blank"
                rel="noreferrer"
              >
                Choose a workstream in Notion ↗
              </a>
            </section>
          )}
          <footer className="page-footer">
            <span>BUILT AROUND SHARED CONTEXT.</span>
            <a href={notion} target="_blank" rel="noreferrer">
              Notion is the team source of context ↗
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
