import { ScheduleList } from "../schedules/ScheduleList";
import { TaskList } from "../tasks/TaskList";
import { TemplateList } from "../templates/TemplateList";

/**
 * The sidebar's Tasks section: the task list, then the Templates and
 * Schedules sections. Shown only with the Tasks list (`section` "tasks"), so
 * it is a chunk of its own, loaded with the Tasks screen (`TasksSection` in
 * ./screens).
 */
export function TasksSection({ labelledBy }: { labelledBy: string }) {
  return (
    <>
      <TaskList labelledBy={labelledBy} />
      <TemplateList />
      <ScheduleList />
    </>
  );
}
