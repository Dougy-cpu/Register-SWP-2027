type TaskState = "todo" | "submitted" | "completed" | "overdue" | "not_required";
interface Task {
  taskKey: string;
  required: boolean;
  status: TaskState;
  dueAt: Date | null;
  completedAt: Date | null;
}
interface ProgressContext {
  sessions: Array<{ id: number; status: string; slidesRequired: boolean }>;
  assets: Array<{ id: string; category: string; status: string; sessionId: number | null }>;
  contacts: Array<{
    role: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  }>;
  documents: Array<{ assetId: string; required: boolean; acknowledged: boolean }>;
}

// Read models use the actual deliverables, not the status of the last individual upload/session.
// Explicit team and Social confirmations stay in sponsor_tasks and reopen after roster changes.
export function deriveSponsorTasks<T extends Task>(
  tasks: T[],
  context: ProgressContext,
  now = new Date(),
): T[] {
  const files = context.assets.filter((asset) => asset.status === "active");
  return tasks.map((task) => {
    if (!task.required) return task;
    let status = task.status;
    switch (task.taskKey) {
      case "sessions":
      case "speakers":
        status = !context.sessions.length
          ? "submitted"
          : context.sessions.every((session) => ["approved", "exported"].includes(session.status))
            ? "completed"
            : context.sessions.every((session) =>
                  ["submitted", "approved", "exported"].includes(session.status),
                )
              ? "submitted"
              : "todo";
        break;
      case "assets":
        status = files.some((asset) => asset.category === "logo") ? "completed" : "todo";
        break;
      case "slides": {
        const sessions = context.sessions.filter((session) => session.slidesRequired);
        status = !sessions.length
          ? "submitted"
          : sessions.every((session) =>
                files.some(
                  (asset) => asset.sessionId === session.id && asset.category === "slides",
                ),
              )
            ? "completed"
            : "todo";
        break;
      }
      case "onsite_contacts":
        status = context.contacts.some(
          (contact) =>
            contact.role === "onsite" &&
            contact.firstName &&
            contact.lastName &&
            contact.email &&
            contact.phone,
        )
          ? "completed"
          : "todo";
        break;
      case "logistics": {
        const documents = context.documents.filter((document) => document.required);
        status = !documents.length
          ? "submitted"
          : documents.every(
                (document) =>
                  document.acknowledged && files.some((asset) => asset.id === document.assetId),
              )
            ? "completed"
            : "todo";
        break;
      }
    }
    if (status === "todo" && task.dueAt && task.dueAt <= now) status = "overdue";
    return { ...task, status, completedAt: status === "completed" ? task.completedAt : null };
  });
}
