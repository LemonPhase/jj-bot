// @vitest-environment jsdom
import "../../test/dom";
import type { TaskView } from "@jj/contracts";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { TestShell } from "../../test/shell";
import { ArtifactList } from "./ArtifactList";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskChat } from "./TaskChat";

configure({ asyncUtilTimeout: 5000 });

const demo = () => createDemoApi({ autoplay: false, tasks: [] });

function renderReady(ui: ReactNode, api: JJApi) {
  function Ready({ children }: { children: ReactNode }) {
    const { loading } = useWorkspace();
    return loading ? null : <>{children}</>;
  }
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <TestShell>
          <Ready>{ui}</Ready>
        </TestShell>
      </WorkspaceProvider>
    </ApiProvider>,
  );
}

/** The task's chat and files, following its view. */
function Followed({ api, taskId }: { api: JJApi; taskId: string }) {
  const [view, setView] = useState<TaskView | null>(null);
  useEffect(() => api.subscribeTask(taskId, setView), [api, taskId]);
  return view ? (
    <>
      <TaskChat view={view} />
      <ArtifactList view={view} />
    </>
  ) : null;
}

const pick = (input: HTMLElement, files: File[]) =>
  fireEvent.change(input, { target: { files } });

const fileInput = (name: string) =>
  screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;

describe("the New task dialog's files", () => {
  it("stages picked files with their sizes, refuses one over the limit in place, and attaches the rest", async () => {
    const api = demo();
    const stage = vi.spyOn(api, "stageUpload");
    const remove = vi.spyOn(api, "deleteUpload");
    const create = vi.spyOn(api, "createTask");
    const onClose = vi.fn();
    const [bot] = await api.listBots();
    renderReady(
      <NewTaskDialog initialBotIds={[bot?.id ?? ""]} onClose={onClose} />,
      api,
    );
    const files = await screen.findByRole("group", {
      name: "Files · optional",
    });
    expect(
      within(files).getByText(/Up to 20 files of 16\.8 MB each/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Read the data" },
    });
    pick(fileInput("Files to upload"), [
      new File(["id,name\n1,Ada\n"], "data.csv", { type: "text/csv" }),
      new File(["# Spec\n"], "spec.md"),
    ]);
    const list = await screen.findByRole("list", { name: "Files to upload" });
    await waitFor(() =>
      expect(within(list).getAllByText(/· ready$/)).toHaveLength(2),
    );
    expect(within(list).getByText("14 B · ready")).toBeTruthy();
    expect(stage).toHaveBeenCalledTimes(2);

    // Over the limit: refused in place, without a request, and it blocks Start.
    const big = new File(["x"], "huge.bin");
    Object.defineProperty(big, "size", { value: 17 * 1024 * 1024 });
    pick(fileInput("Files to upload"), [big]);
    expect((await within(list).findByRole("alert")).textContent).toMatch(
      /Not uploaded 17\.8 MB is over the 16\.8 MB a file can be\./,
    );
    expect(stage).toHaveBeenCalledTimes(2);
    const start = screen.getByRole("button", { name: "Start task" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove huge.bin" }));
    // Removing a staged file deletes it on the server.
    fireEvent.click(screen.getByRole("button", { name: "Remove spec.md" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(start);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0].uploads).toHaveLength(1);
    const task = await create.mock.results[0]?.value;
    const view = await api.getTask(task.id);
    expect(
      view.artifacts.map((artifact) => [artifact.path, artifact.upload?.state]),
    ).toEqual([["uploads/data.csv", "pending"]]);
    // Attached: nothing is deleted once the dialog has gone.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("removes what it staged when it is cancelled", async () => {
    const api = demo();
    const remove = vi.spyOn(api, "deleteUpload");
    const [bot] = await api.listBots();
    const onClose = vi.fn();
    const { unmount } = render(
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <TestShell>
            <NewTaskDialog initialBotIds={[bot?.id ?? ""]} onClose={onClose} />
          </TestShell>
        </WorkspaceProvider>
      </ApiProvider>,
    );
    pick(await waitFor(() => fileInput("Files to upload")), [
      new File(["a"], "a.txt"),
    ]);
    await screen.findByText("1 B · ready");
    unmount();
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  });
});

describe("uploads in the task chat", () => {
  it("shows an upload card with each file's state and download, attaches with the paperclip, and labels the files as the user's", async () => {
    const api = demo();
    const [bot] = await api.listBots();
    const data = await api.stageUpload(new File(["a,b\n"], "a.csv"), "a.csv");
    const task = await api.createTask({
      goal: "Read a.csv",
      coordinatorBotId: bot?.id ?? "",
      uploads: [{ uploadId: data.id }],
    });
    renderReady(<Followed api={api} taskId={task.id} />, api);
    const card = await screen.findByRole("article", {
      name: "You uploaded 1 file",
    });
    expect(within(card).getByText("Waiting for the next run")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Download a.csv" }),
    ).toBeTruthy();
    await api.advanceDemoTask?.(task.id);
    expect(
      await within(card).findByText("In workspace · uploads/a.csv"),
    ).toBeTruthy();
    expect(screen.getByText("4 B · Uploaded by you")).toBeTruthy();

    // The paperclip: pick a file, then upload it on its own.
    const attach = vi.spyOn(api, "uploadToTask");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    pick(fileInput("Files to upload into the task"), [
      new File(["notes"], "notes.md"),
    ]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload 1 file" }),
    );
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getAllByRole("article", { name: "You uploaded 1 file" }),
      ).toHaveLength(2),
    );
  });

  it("sends picked files ahead of the message that goes with them", async () => {
    const api = demo();
    const [bot] = await api.listBots();
    const task = await api.createTask({
      goal: "Wait for files",
      coordinatorBotId: bot?.id ?? "",
    });
    const order: string[] = [];
    const original = api.uploadToTask.bind(api);
    vi.spyOn(api, "uploadToTask").mockImplementation(
      async (taskId, command) => {
        order.push("upload");
        return original(taskId, command);
      },
    );
    const post = vi.spyOn(api, "postTaskMessage");
    post.mockImplementation(async () => {
      order.push("message");
      throw new Error("stop here");
    });
    renderReady(<Followed api={api} taskId={task.id} />, api);
    pick(await waitFor(() => fileInput("Files to upload into the task")), [
      new File(["x"], "x.txt"),
    ]);
    await screen.findByRole("button", { name: "Upload 1 file" });
    fireEvent.change(screen.getByLabelText("Message the task group"), {
      target: { value: "Here is x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(order).toEqual(["upload", "message"]));
  });
});
