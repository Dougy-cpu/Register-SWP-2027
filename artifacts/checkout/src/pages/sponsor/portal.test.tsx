import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorSession } from "@/types/sponsor";
import SponsorPortal from "./portal";
import { PortalSession, sessionDraftKey } from "./portal-session";
import { PortalTeam } from "./portal-team";
import { PortalEvent } from "./portal-event";
import { UploadField, EventDocument } from "./portal-ui";
import { preparationSteps, sessionDraft, sessionMissingItems } from "./portal-helpers";
import { createPortalFixture, makeAsset, makeSession, makeStaff } from "./__fixtures__/portal";

vi.mock("@/lib/sponsor-api", () => ({ sponsorJson: vi.fn() }));
const api = vi.mocked(sponsorJson);
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live requests are forbidden in portal tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function SessionHarness({ initial = makeSession() }: { initial?: SponsorSession }) {
  const [session, setSession] = useState(initial);
  return (
    <PortalSession
      sponsorId={1}
      session={session}
      assets={[]}
      onSaved={setSession}
      onUploaded={vi.fn()}
      onBack={vi.fn()}
      onRefresh={vi.fn()}
    />
  );
}

describe("Sponsor session editing", () => {
  it("submits the currently typed details, preserves presenter IDs and does not require final slides", async () => {
    api.mockImplementation(async (path, init) =>
      path.endsWith("/submit")
        ? makeSession({ title: "Updated title", currentRevision: 2, status: "submitted" })
        : makeSession({ ...JSON.parse(String(init?.body)), currentRevision: 2 }),
    );
    render(<SessionHarness />);
    fireEvent.change(screen.getByLabelText("Session title"), {
      target: { value: "Updated title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await screen.findByText(/Your session is with the event team/);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.map(([path]) => path)).toEqual(["/api/sponsor/sessions/11/submit"]);
    expect(JSON.parse(String(api.mock.calls[0][1]?.body))).toMatchObject({
      title: "Updated title",
      expectedRevision: 1,
      presenters: [{ id: 21 }],
    });
  });
  it("keeps the draft and never submits when saving fails", async () => {
    api.mockRejectedValue(new Error("Connection interrupted. Try again."));
    render(<SessionHarness />);
    fireEvent.change(screen.getByLabelText("Session title"), {
      target: { value: "Keep this text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await screen.findByRole("alert");
    expect(api).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Session title") as HTMLInputElement).value).toBe(
      "Keep this text",
    );
    expect(JSON.parse(localStorage.getItem(sessionDraftKey(1, 11))!).draft.title).toBe(
      "Keep this text",
    );
  });
  it("restores drafts after switching sessions or refreshing and blocks overwriting a newer revision", () => {
    const first = render(<SessionHarness />);
    fireEvent.change(screen.getByLabelText("Session title"), {
      target: { value: "Unfinished draft" },
    });
    first.unmount();
    // Leaving flushes a quiet draft; a stale editor still must not submit it.
    expect(api.mock.calls[0][0]).toBe("/api/sponsor/sessions/11");
    api.mockClear();
    render(
      <SessionHarness
        initial={makeSession({ currentRevision: 3, title: "Someone else's update" })}
      />,
    );
    expect((screen.getByLabelText("Session title") as HTMLInputElement).value).toBe(
      "Unfinished draft",
    );
    expect(screen.getByText(/This session was updated elsewhere/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(api).not.toHaveBeenCalled();
  });
  it("does not duplicate submission while the first request is pending", async () => {
    let finish!: (value: SponsorSession) => void;
    api.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<SessionHarness />);
    const submit = screen.getByRole("button", { name: "Submit for review" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    finish(makeSession({ status: "submitted" }));
    await screen.findByText(/Your session is with the event team/);
  });
  it("saves a new speaker before uploading a headshot and links the returned ID", async () => {
    api.mockImplementation(async (path) =>
      path === "/api/sponsor/assets"
        ? makeAsset({ presenterId: 88 })
        : makeSession({
            currentRevision: 1,
            presenters: [
              { id: 88, name: "New Speaker", jobTitle: "Director", company: "Example Partners" },
            ],
          }),
    );
    render(<SessionHarness initial={makeSession({ currentRevision: 0, presenters: [] })} />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Speaker" } });
    fireEvent.change(screen.getByLabelText("Upload speaker photo"), {
      target: { files: [new File(["image"], "speaker.png", { type: "image/png" })] },
    });
    await screen.findByText("Uploaded successfully");
    const body = api.mock.calls[1][1]?.body as FormData;
    expect(body.get("presenterId")).toBe("88");
    expect(body.get("sessionId")).toBe("11");
  });
});

describe("Simple preparation steps and forms", () => {
  it("warns before closing only when a team form has unfinished changes", () => {
    render(<PortalTeam workspace={createPortalFixture()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
    const emptyFormClose = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(emptyFormClose);
    expect(emptyFormClose.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Unfinished" } });
    const editedFormClose = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(editedFormClose);
    expect(editedFormClose.defaultPrevented).toBe(true);
  });
  it("gives each speaking slot an action and separates review from final slides", () => {
    const fixture = createPortalFixture();
    fixture.sessions[0].status = "submitted";
    const steps = preparationSteps(fixture);
    expect(steps.find((step) => step.key === "session-11")?.state).toBe("waiting");
    expect(steps.find((step) => step.key === "session-12")?.state).toBe("todo");
    expect(steps.find((step) => step.key === "slides-11")?.state).toBe("todo");
    expect(steps.find((step) => step.key === "logistics")?.state).toBe("waiting");
    expect(sessionMissingItems(sessionDraft(fixture.sessions[0]), fixture.sessions[0], [])).toEqual(
      [],
    );
  });
  it("does not treat an archived headshot as complete", () => {
    const session = makeSession({ headshotRequired: true });
    expect(
      sessionMissingItems(sessionDraft(session), session, [makeAsset({ status: "archived" })]),
    ).toContain("Upload a photo for each speaker");
  });
  it("offers an explicit team confirmation even with unused staff places", async () => {
    api.mockResolvedValue({});
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PortalTeam workspace={createPortalFixture()} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm team list" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(api.mock.calls[0][0]).toBe("/api/sponsor/tasks/staff/complete");
  });
  it("registers only after confirmation, keeping marketing consent off", async () => {
    api.mockResolvedValue({});
    render(<PortalTeam workspace={createPortalFixture()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
    for (const [label, value] of [
      ["First name", "Sam"],
      ["Last name", "Example"],
      ["Job title", "Director"],
      ["Work email", "sam@example.invalid"],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm registration" }));
    await screen.findByText("Team member registered.");
    expect(JSON.parse(String(api.mock.calls[0][1]?.body))).toMatchObject({
      marketingConsent: false,
      communitySocialAttending: null,
    });
  });
  it("updates the main contact as onsite without creating a duplicate contact", async () => {
    const fixture = createPortalFixture();
    api.mockResolvedValue({ ...fixture.contacts[0], role: "onsite" });
    render(
      <PortalEvent
        workspace={fixture}
        onRefresh={vi.fn()}
        onUploaded={vi.fn()}
        onEditSocial={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use main contact" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm onsite contact" }));
    await screen.findByText("Onsite contact confirmed.");
    expect(JSON.parse(String(api.mock.calls[0][1]?.body))).toMatchObject({
      id: 51,
      email: "jamie@example.invalid",
    });
  });
  it("cannot confirm Social while a staff member has not answered", () => {
    render(
      <PortalEvent
        workspace={createPortalFixture()}
        onRefresh={vi.fn()}
        onUploaded={vi.fn()}
        onEditSocial={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm no one attending" }));
    expect(api).not.toHaveBeenCalled();
  });
  it("keeps all four tabs accessible and preserves an open staff form across navigation", async () => {
    api.mockResolvedValue(createPortalFixture());
    render(<SponsorPortal />);
    await screen.findByRole("heading", { name: "Your next steps" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Home",
      "Team & passes",
      "Sessions",
      "Event details",
    ]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Team & passes" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
    fireEvent.change(screen.getByRole("textbox", { name: "First name" }), {
      target: { value: "Unfinished" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sessions" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getAllByRole("button", { name: /^Open .+/ })).toHaveLength(2);
    expect(screen.queryByLabelText("Session title")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Team & passes" }), {
      button: 0,
      ctrlKey: false,
    });
    expect((screen.getByRole("textbox", { name: "First name" }) as HTMLInputElement).value).toBe(
      "Unfinished",
    );
  });
  it("allows additional material without replacing the first file", async () => {
    api.mockResolvedValue(makeAsset());
    render(
      <UploadField
        label="Upload material"
        category="session_material"
        files={[makeAsset({ category: "session_material" })]}
        onUploaded={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Upload material"), {
      target: { files: [new File(["pdf"], "more.pdf", { type: "application/pdf" })] },
    });
    await screen.findByText("Uploaded successfully");
    expect(api.mock.calls[0][0]).toBe("/api/sponsor/assets");
  });
  it("requires acknowledgement again when a new document version is displayed", () => {
    const document = {
      id: 61,
      assetId: "doc",
      title: "Event guide",
      required: true,
      acknowledgementVersion: 1,
      acknowledged: true,
      acknowledgedBy: "Alex",
      acknowledgedAt: "2026-09-04",
    };
    const view = render(<EventDocument document={document} available onAcknowledged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "I've read this" })).toBeNull();
    view.rerender(
      <EventDocument
        document={{ ...document, acknowledgementVersion: 2, acknowledged: false }}
        available
        onAcknowledged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "I've read this" })).toBeTruthy();
  });
  it("keeps a completed Social step complete only while all active staff have answered", () => {
    const fixture = createPortalFixture();
    fixture.tasks.find((task) => task.taskKey === "community_social")!.status = "completed";
    fixture.staff = [makeStaff({ communitySocialAttending: false })];
    expect(preparationSteps(fixture).find((step) => step.key === "community_social")?.state).toBe(
      "complete",
    );
    fixture.staff.push(makeStaff({ bookingId: 32 }));
    expect(preparationSteps(fixture).find((step) => step.key === "community_social")?.state).toBe(
      "todo",
    );
  });
});
