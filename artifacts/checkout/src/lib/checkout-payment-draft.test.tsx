import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_FIELDS,
  paymentDraftBody,
  readPaymentDraft,
  usePaymentDraft,
  type PaymentDraft,
} from "./checkout-payment-draft";

function draft(billing: Partial<PaymentDraft["billing"]> = {}): PaymentDraft {
  return {
    paymentMethod: "invoice",
    billing: {
      ...Object.fromEntries(BILLING_FIELDS.map((field) => [field, ""])),
      billingName: "Alex Morgan",
      billingEmail: "alex@example.com",
      billingCountry: "GB",
      ...billing,
    } as PaymentDraft["billing"],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advance(milliseconds = 600) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("checkout payment draft protection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("booking_session", "session-a");
  });

  afterEach(async () => {
    await act(async () => cleanup());
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("isolates cached drafts by both booking and booking session", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const first = renderHook(usePaymentDraft, {
      initialProps: { bookingId: 10, draft: draft(), restored: false, enabled: true, save },
    });
    const firstEdit = draft({ poNumber: "PO-FIRST" });
    first.rerender({ bookingId: 10, draft: firstEdit, restored: false, enabled: true, save });

    const second = renderHook(usePaymentDraft, {
      initialProps: { bookingId: 11, draft: draft(), restored: false, enabled: true, save },
    });
    const secondEdit = draft({ poNumber: "PO-SECOND" });
    second.rerender({ bookingId: 11, draft: secondEdit, restored: false, enabled: true, save });

    expect(readPaymentDraft(10)).toEqual(firstEdit);
    expect(readPaymentDraft(11)).toEqual(secondEdit);
    expect(readPaymentDraft(12)).toBeNull();
    window.localStorage.setItem("booking_session", "session-b");
    expect(readPaymentDraft(10)).toBeNull();
    expect(readPaymentDraft(11)).toBeNull();
    window.localStorage.removeItem("booking_session");
    window.sessionStorage.setItem("booking_session", "session-a");
    expect(readPaymentDraft(10)).toEqual(firstEdit);
    expect(readPaymentDraft(11)).toEqual(secondEdit);
    expect(save).not.toHaveBeenCalled();
  });

  it("recovers an unsent draft after remount and synchronises it to the server", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const first = renderHook(usePaymentDraft, { initialProps });
    const edit = draft({ billingAddressLine1: "24 High Street", poNumber: "PO-42" });
    first.rerender({ ...initialProps, draft: edit });
    first.unmount();

    const recovered = readPaymentDraft(10);
    expect(recovered).toEqual(edit);
    const resumed = renderHook(usePaymentDraft, {
      initialProps: { ...initialProps, draft: recovered!, restored: true },
    });
    expect(resumed.result.current.status).toBe("saving");
    await advance();

    expect(save).toHaveBeenCalled();
    expect(
      save.mock.calls.every(
        ([body]) => JSON.stringify(body) === JSON.stringify(paymentDraftBody(edit)),
      ),
    ).toBe(true);
    expect(resumed.result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("caches changes immediately and debounces rapid edits into one server save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    await advance();
    expect(save).not.toHaveBeenCalled();

    rerender({ ...initialProps, draft: draft({ poNumber: "PO-4" }) });
    await advance(500);
    const edit = draft({ poNumber: "PO-42" });
    rerender({ ...initialProps, draft: edit });
    expect(readPaymentDraft(10)).toEqual(edit);
    expect(result.current.status).toBe("saving");
    await advance(599);
    expect(save).not.toHaveBeenCalled();
    await advance(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(paymentDraftBody(edit));
    expect(result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("serialises slow saves and keeps the newer draft protected until it is durable", async () => {
    const older = deferred();
    const newer = deferred();
    const save = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    const firstEdit = draft({ poNumber: "PO-OLD" });
    const secondEdit = draft({ poNumber: "PO-NEW" });
    rerender({ ...initialProps, draft: firstEdit });
    await advance();
    rerender({ ...initialProps, draft: secondEdit });
    await advance();
    expect(save).toHaveBeenCalledTimes(1);
    expect(readPaymentDraft(10)).toEqual(secondEdit);

    await act(async () => older.resolve());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, paymentDraftBody(firstEdit));
    expect(save).toHaveBeenNthCalledWith(2, paymentDraftBody(secondEdit));
    expect(result.current.status).toBe("saving");
    expect(readPaymentDraft(10)).toEqual(secondEdit);

    await act(async () => newer.resolve());
    expect(result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("saves a return to the original value after an older edit is already in flight", async () => {
    const pending = deferred();
    const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    rerender({ ...initialProps, draft: draft({ poNumber: "TEMPORARY" }) });
    await advance();
    expect(save).toHaveBeenCalledTimes(1);
    rerender(initialProps);
    await advance();

    await act(async () => pending.resolve());

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(paymentDraftBody(initialProps.draft));
    expect(result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("serialises saves across remounts without an old screen clearing the newer draft", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    const oldSave = vi.fn().mockReturnValue(oldRequest.promise);
    const newSave = vi.fn().mockReturnValue(newRequest.promise);
    const firstProps = {
      bookingId: 10,
      draft: draft(),
      restored: false,
      enabled: true,
      save: oldSave,
    };
    const first = renderHook(usePaymentDraft, { initialProps: firstProps });
    const oldDraft = draft({ poNumber: "PO-BEFORE-BACK" });
    first.rerender({ ...firstProps, draft: oldDraft });
    await advance();
    first.unmount();

    const secondProps = {
      ...firstProps,
      draft: readPaymentDraft(10)!,
      restored: true,
      save: newSave,
    };
    const second = renderHook(usePaymentDraft, { initialProps: secondProps });
    const newDraft = draft({ poNumber: "PO-AFTER-RETURN" });
    second.rerender({ ...secondProps, draft: newDraft });
    await advance();
    expect(newSave).not.toHaveBeenCalled();

    await act(async () => oldRequest.resolve());
    expect(oldSave).toHaveBeenCalledTimes(1);
    expect(newSave).toHaveBeenCalledTimes(1);
    expect(newSave).toHaveBeenCalledWith(paymentDraftBody(newDraft));
    expect(readPaymentDraft(10)).toEqual(newDraft);
    expect(second.result.current.status).toBe("saving");

    await act(async () => newRequest.resolve());
    expect(readPaymentDraft(10)).toBeNull();
    expect(second.result.current.status).toBe("saved");
  });

  it("does not let completion in a previous session clear the current session's pending draft", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    const oldSave = vi.fn().mockReturnValue(oldRequest.promise);
    const newSave = vi.fn().mockReturnValue(newRequest.promise);
    const oldProps = {
      bookingId: 10,
      draft: draft(),
      restored: false,
      enabled: true,
      save: oldSave,
    };
    const oldSession = renderHook(usePaymentDraft, { initialProps: oldProps });
    const edit = draft({ poNumber: "IDENTICAL-VISIBLE-DRAFT" });
    oldSession.rerender({ ...oldProps, draft: edit });
    await advance();

    window.localStorage.setItem("booking_session", "session-b");
    const newProps = { ...oldProps, save: newSave };
    const newSession = renderHook(usePaymentDraft, { initialProps: newProps });
    newSession.rerender({ ...newProps, draft: edit });
    await advance();
    expect(newSave).toHaveBeenCalledTimes(1);
    expect(readPaymentDraft(10)).toEqual(edit);

    await act(async () => oldRequest.resolve());
    const currentSessionDraftWhilePending = readPaymentDraft(10);
    window.localStorage.setItem("booking_session", "session-a");
    const previousSessionDraftAfterSaving = readPaymentDraft(10);
    window.localStorage.setItem("booking_session", "session-b");

    await act(async () => newRequest.resolve());
    expect(currentSessionDraftWhilePending).toEqual(edit);
    expect(previousSessionDraftAfterSaving).toBeNull();
    expect(readPaymentDraft(10)).toBeNull();
    expect(newSession.result.current.status).toBe("saved");
  });

  it("retains the draft after a failed save and permits an explicit successful retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    const edit = draft({ billingTown: "Manchester", poNumber: "PO-RETRY" });
    rerender({ ...initialProps, draft: edit });
    await advance();
    expect(result.current.status).toBe("error");
    expect(readPaymentDraft(10)).toEqual(edit);

    await act(async () => result.current.flush());

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(paymentDraftBody(edit));
    expect(result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("resumes a pending debounce after saving is temporarily disabled", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    const edit = draft({ poNumber: "PO-PAUSED" });
    rerender({ ...initialProps, draft: edit });
    await advance(300);
    rerender({ ...initialProps, draft: edit, enabled: false });
    await advance();
    expect(save).not.toHaveBeenCalled();
    expect(readPaymentDraft(10)).toEqual(edit);

    rerender({ ...initialProps, draft: edit, enabled: true });
    await advance();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(paymentDraftBody(edit));
    expect(result.current.status).toBe("saved");
    expect(readPaymentDraft(10)).toBeNull();
  });

  it("does not save a disabled screen's changed fields when it unmounts", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: false, save };
    const { rerender, unmount } = renderHook(usePaymentDraft, { initialProps });
    rerender({ ...initialProps, draft: draft({ poNumber: "DO-NOT-SAVE" }) });
    await act(async () => unmount());
    await advance();
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects a queued write if the authenticated booking session changes before it starts", async () => {
    const pending = deferred();
    const save = vi.fn().mockReturnValue(pending.promise);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    rerender({ ...initialProps, draft: draft({ poNumber: "PO-IN-FLIGHT" }) });
    await advance();
    const queued = draft({ poNumber: "PO-QUEUED" });
    rerender({ ...initialProps, draft: queued });
    await advance();
    window.localStorage.setItem("booking_session", "session-b");

    await act(async () => pending.resolve());

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("error");
    expect(readPaymentDraft(10)).toBeNull();
    window.localStorage.setItem("booking_session", "session-a");
    expect(readPaymentDraft(10)).toEqual(queued);
  });

  it("flush waits for an in-flight save and persists the latest visible edit before resolving", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
    const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
    rerender({ ...initialProps, draft: draft({ poNumber: "PO-OLDER" }) });
    await advance();
    const latest = draft({ poNumber: "PO-FINAL" });
    rerender({ ...initialProps, draft: latest });
    const resolved = vi.fn();
    let flush!: Promise<unknown>;
    act(() => {
      flush = result.current.flush().then(resolved);
    });
    expect(resolved).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(paymentDraftBody(latest));
    expect(resolved).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve();
      await flush;
    });
    await advance();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("saved");
  });

  it.each(["getItem", "setItem"] as const)(
    "continues server persistence when browser storage %s is unavailable",
    async (operation) => {
      const save = vi.fn().mockResolvedValue(undefined);
      const initialProps = { bookingId: 10, draft: draft(), restored: false, enabled: true, save };
      const { result, rerender } = renderHook(usePaymentDraft, { initialProps });
      if (operation === "getItem") {
        const getItem = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
          if (this === window.sessionStorage) {
            throw new DOMException("Draft storage unavailable", "SecurityError");
          }
          return getItem.call(this, key);
        });
      } else {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("Draft storage unavailable", "SecurityError");
        });
      }
      const edit = draft({ billingCompany: "Updated company" });
      rerender({ ...initialProps, draft: edit });
      await advance();

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(paymentDraftBody(edit));
      expect(result.current.status).toBe("saved");
    },
  );
});
