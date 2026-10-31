import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScannerSummary } from "@/hooks/use-scanner-summary";
import { recordScannerContact } from "@/lib/scanner-connection";
import { ScannerSaveStatus } from "./scanner-save-status";

const empty: ScannerSummary = {
  leads: [],
  pendingScans: 0,
  pendingNotes: 0,
  otherWork: 0,
  otherPending: 0,
  rejected: 0,
  error: "",
  loaded: true,
};

beforeEach(() => recordScannerContact(true));
afterEach(cleanup);

it.each([
  ["empty queue", {}, false],
  ["rejected badge only", { rejected: 1 }, false],
  ["other rep needs recovery", { otherWork: 1 }, false],
  ["queued badge", { pendingScans: 1 }, true],
  ["queued note only", { pendingNotes: 1 }, true],
  ["another authorised rep's queued note", { otherWork: 1, otherPending: 1 }, true],
  ["storage unavailable", { pendingNotes: 1, error: "Saved totals are unavailable." }, false],
  ["opening the queue", { pendingNotes: 1, loaded: false }, false],
] as const)(
  "shows the manual retry only for work that can upload: %s",
  (_label, values, visible) => {
    render(<ScannerSaveStatus summary={{ ...empty, ...values }} onSync={vi.fn()} />);
    expect(Boolean(screen.queryByRole("button", { name: "Sync now" }))).toBe(visible);
  },
);

it("retains waiting counts, prevents repeat taps and removes the action after acknowledgement", async () => {
  let finish!: () => void;
  const sync = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const queued = { ...empty, pendingScans: 1, pendingNotes: 1 };
  const view = render(<ScannerSaveStatus summary={queued} onSync={sync} dark />);
  act(() => window.dispatchEvent(new Event("offline")));
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  const busy = screen.getByRole("button", { name: "Syncing…" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  fireEvent.click(busy);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(screen.getByText("1 badge and 1 note update waiting to back up.")).toBeTruthy();
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
  view.rerender(<ScannerSaveStatus summary={empty} onSync={sync} dark />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("remembers an outage before mount and across screens until the server responds", () => {
  act(() => window.dispatchEvent(new Event("offline")));
  const first = render(
    <ScannerSaveStatus summary={{ ...empty, loaded: false }} onSync={vi.fn()} />,
  );
  expect(screen.getByText(/Connection unavailable/)).toBeTruthy();
  first.unmount();
  act(() => window.dispatchEvent(new Event("online")));
  render(<ScannerSaveStatus summary={empty} onSync={vi.fn()} dark />);
  expect(screen.getByText(/Connection unavailable/)).toBeTruthy();
  act(() => recordScannerContact(true));
  expect(screen.queryByText(/Connection unavailable/)).toBeNull();
});
