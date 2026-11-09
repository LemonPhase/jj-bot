import type { Bot } from "@jj/contracts";
import { useId } from "react";
import { Avatar, Chip, SectionLabel, Select } from "../../components/ui";
import "./tasks.css";

export interface TeamPickerProps {
  bots: readonly Bot[];
  coordinatorId: string;
  onCoordinator: (botId: string) => void;
  /** The other participants picked; the coordinator always takes part. */
  others: readonly string[];
  onOthers: (botIds: string[]) => void;
}

/** The roster as a task sends it: the coordinator first, then the others picked. */
export const rosterOf = (
  coordinatorId: string,
  others: readonly string[],
): string[] =>
  [coordinatorId, ...others.filter((botId) => botId !== coordinatorId)].filter(
    Boolean,
  );

/**
 * A task's team, as the New task dialog and the template editor pick it: the
 * coordinator who plans and delegates, and chips for the other participants.
 */
export function TeamPicker({
  bots,
  coordinatorId,
  onCoordinator,
  others,
  onOthers,
}: TeamPickerProps) {
  const pickLabelId = useId();
  const participants = rosterOf(coordinatorId, others);
  const toggle = (botId: string) =>
    onOthers(
      others.includes(botId)
        ? others.filter((id) => id !== botId)
        : [...others, botId],
    );
  return (
    <>
      <Select
        label="Coordinator"
        value={coordinatorId}
        onChange={onCoordinator}
        options={bots.map((bot) => ({
          value: bot.id,
          label: bot.role ? `${bot.name} · ${bot.role}` : bot.name,
        }))}
      />
      <div className="new-task-form__bots">
        <SectionLabel id={pickLabelId} tracking="part">
          Participants · {participants.length}
        </SectionLabel>
        <div
          className="new-task-form__chips"
          role="group"
          aria-labelledby={pickLabelId}
        >
          {bots.map((bot) => {
            const isCoordinator = bot.id === coordinatorId;
            return (
              <Chip
                key={bot.id}
                selected={isCoordinator || others.includes(bot.id)}
                aria-disabled={isCoordinator || undefined}
                onClick={() => {
                  if (!isCoordinator) toggle(bot.id);
                }}
                leading={
                  <Avatar
                    appearance={bot.appearance}
                    name={bot.name}
                    size={18}
                    animate={false}
                    decorative
                  />
                }
              >
                {bot.name}
                {isCoordinator && (
                  <span className="new-task-form__coordinator">
                    · coordinator
                  </span>
                )}
              </Chip>
            );
          })}
        </div>
      </div>
    </>
  );
}
