import type { TaskTemplate } from "@jj/contracts";
import { useId } from "react";
import { Button, Icon, IconButton, SectionLabel } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { useShell } from "../shell/ShellContext";
import { problemLines } from "./templateModel";
import "./templates.css";

/**
 * The Templates section of the Tasks sidebar: each saved template with Start,
 * Edit and Delete, and a warning instead of Start while it has problems. Shown
 * only when the server serves templates.
 */
export function TemplateList() {
  const { templates, getBot } = useWorkspace();
  const { openTemplateDialog } = useShell();
  const labelId = useId();
  if (templates === null) return null;
  return (
    <section className="template-list" aria-labelledby={labelId}>
      <div className="template-list__head">
        <SectionLabel as="h2" id={labelId} className="shell-list__label">
          Templates
        </SectionLabel>
        <IconButton
          label="New template"
          icon={<Icon name="plus" size={14} />}
          onClick={() => openTemplateDialog({ kind: "new" })}
        />
      </div>
      {templates.length === 0 ? (
        <p className="shell-list__note">
          Save a task as a template to start it again in one step.
        </p>
      ) : (
        <ul className="template-list__rows" aria-labelledby={labelId}>
          {templates.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              coordinator={getBot(template.coordinatorBotId)?.name}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateRow({
  template,
  coordinator,
}: {
  template: TaskTemplate;
  coordinator: string | undefined;
}) {
  const { openTemplateDialog } = useShell();
  const problemId = useId();
  const problems = problemLines(template.problems);
  const count = template.participantBotIds.length;
  const open = (kind: "start" | "edit" | "delete") =>
    openTemplateDialog({ kind, templateId: template.id });
  return (
    <li className="template-row">
      <span className="template-row__title clamp2">{template.title}</span>
      {problems.length > 0 ? (
        <span id={problemId} className="template-row__problem">
          <span className="template-row__mark" aria-hidden="true">
            !
          </span>
          {problems.join(" ")}
        </span>
      ) : (
        <span className="template-row__meta">
          {coordinator ?? "Coordinator"} · {count}{" "}
          {count === 1 ? "bot" : "bots"}
        </span>
      )}
      <span className="template-row__actions">
        <Button
          size="sm"
          variant="primary"
          aria-label={`Start ${template.title}`}
          disabled={problems.length > 0}
          aria-describedby={problems.length > 0 ? problemId : undefined}
          onClick={() => open("start")}
        >
          Start
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Edit ${template.title}`}
          onClick={() => open("edit")}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete ${template.title}`}
          onClick={() => open("delete")}
        >
          Delete
        </Button>
      </span>
    </li>
  );
}
