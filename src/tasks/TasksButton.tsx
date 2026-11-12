import { ListTodo } from "lucide-react";
import { Dropdown } from "../ui/Dropdown";
import { countLabel } from "../panels/Notifications";
import { TASKS_SHORTCUT } from "../shortcuts";
import { TASK_SURFACES, TasksPanel } from "../lazySurfaces";
import { whenLoaded } from "../lazySurface";
import { useTasksUi } from "./taskStore";
import { useNeedsYouCount } from "./taskView";
import "./Tasks.css";

/**
 * The top bar's Tasks dropdown, like the other tool menus (Usage,
 * Notifications): the button counts the tasks that need you, and the panel
 * holds the list, the new-task form and one task at a time.
 */
export function TasksButton() {
  const needsYou = useNeedsYouCount();
  const open = useTasksUi((state) => state.open);
  const label = needsYou ? `Tasks: ${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : "Tasks";
  return (
    <Dropdown icon={ListTodo} title={`Tasks (${TASKS_SHORTCUT.label})`} width={380} panelClassName="notifications-panel tasks-menu-panel" tourId="tasks"
      badgeLabel={label} cornerBadge={needsYou ? countLabel(needsYou) : null}
      controlledOpen={open}
      onOpenChange={(value) => { if (!value) useTasksUi.getState().close(); else whenLoaded(TASK_SURFACES, () => useTasksUi.getState().show()); }}>
      {open ? <TasksPanel /> : null}
    </Dropdown>
  );
}
