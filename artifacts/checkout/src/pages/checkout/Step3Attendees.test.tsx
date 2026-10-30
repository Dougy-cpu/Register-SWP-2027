import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingWithAttendees } from "@/types/booking";
import Step3Attendees from "./Step3Attendees";

const mocks = vi.hoisted(() => ({
  updateBooking: vi.fn(),
  createAttendee: vi.fn(),
  updateAttendee: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useUpdateBooking: () => ({ mutateAsync: mocks.updateBooking, isPending: false }),
  useCreateAttendee: () => ({ mutateAsync: mocks.createAttendee }),
  useUpdateAttendee: () => ({ mutateAsync: mocks.updateAttendee }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

const lead = {
  id: 101,
  isLead: true,
  isTbc: false,
  firstName: "Alex",
  lastName: "Morgan",
  jobTitle: "People Director",
  company: "Example company",
  workEmail: "alex@example.com",
  phone: "020 7000 0000",
  dietaryAccessibility: "",
  gdprConsent: true,
};

function makeBooking(quantity = 3, leadOverrides = {}): BookingWithAttendees {
  return {
    id: 20,
    quantity,
    attendees: [{ ...lead, ...leadOverrides }],
  } as unknown as BookingWithAttendees;
}

function input(name: string) {
  return screen.getByRole("textbox", { name }) as HTMLInputElement;
}

function change(name: string, value: string) {
  fireEvent.change(input(name), { target: { value } });
}

async function continueToFirstError() {
  fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

describe("<Step3Attendees /> validation and accessible controls", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.updateBooking.mockResolvedValue({});
    mocks.updateAttendee.mockResolvedValue({});
    mocks.createAttendee.mockResolvedValue({ id: 202 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("opens and focuses the first incomplete attendee, preserving edits across panels", async () => {
    render(<Step3Attendees booking={makeBooking()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Attendee 2/ }));
    change("Last Name *", "Reed");
    change("Job Title *", "HR Director");
    change("Company *", "Second company");
    change("Phone (optional)", "020 7123 4567");
    change("Dietary requirements or accessibility needs (optional)", "Vegetarian");

    fireEvent.click(screen.getByRole("button", { name: /^Attendee 3/ }));
    change("First Name *", "Jordan");
    change("Last Name *", "Nguyen");
    change("Company *", "Third company");
    change("Dietary requirements or accessibility needs (optional)", "Step-free access");

    await continueToFirstError();

    const firstInvalid = input("First Name *");
    expect(screen.getByRole("button", { name: /^Attendee 2/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /^Attendee 3/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(firstInvalid);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(firstInvalid);
    expect(input("Last Name *").value).toBe("Reed");
    expect(input("Company *").value).toBe("Second company");
    expect(input("Phone (optional)").value).toBe("020 7123 4567");
    expect(input("Dietary requirements or accessibility needs (optional)").value).toBe(
      "Vegetarian",
    );
    expect(mocks.updateBooking).not.toHaveBeenCalled();
    expect(mocks.createAttendee).not.toHaveBeenCalled();

    // Repeating Continue on the same open panel must still restore error focus.
    screen.getByRole("button", { name: "Continue to Payment" }).focus();
    await continueToFirstError();
    expect(document.activeElement).toBe(firstInvalid);

    change("First Name *", "Casey");
    change("Work Email *", "casey@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand how my data/ }));
    await continueToFirstError();

    // Email precedes job title visually, even though the schema lists job title first.
    expect(document.activeElement).toBe(input("Work Email *"));
    expect(screen.getByRole("button", { name: /^Attendee 3/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(input("First Name *").value).toBe("Jordan");
    expect(input("Last Name *").value).toBe("Nguyen");
    expect(input("Company *").value).toBe("Third company");
    expect(input("Dietary requirements or accessibility needs (optional)").value).toBe(
      "Step-free access",
    );

    fireEvent.click(screen.getByRole("button", { name: /^Attendee 2/ }));
    expect(input("First Name *").value).toBe("Casey");
    expect(input("Work Email *").value).toBe("casey@example.com");
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it("associates labels and errors, exposes selection and supplies safe attendee autofill groups", async () => {
    render(
      <Step3Attendees
        booking={makeBooking(1, {
          firstName: "",
          lastName: "",
          jobTitle: "",
          company: "",
          workEmail: "",
          gdprConsent: false,
        })}
      />,
    );

    const requiredFields = [
      ["First Name *", "First name is required", "given-name"],
      ["Last Name *", "Last name is required", "family-name"],
      ["Work Email *", "Valid email is required", "email"],
      ["Job Title *", "Job title is required", "organization-title"],
      ["Company *", "Company is required", "organization"],
    ];
    const ids = requiredFields.map(([name]) => input(name).id);
    expect(new Set(ids).size).toBe(requiredFields.length);

    for (const [name, , autofill] of requiredFields) {
      const field = input(name);
      expect(field.id).not.toBe("");
      expect(field.labels?.[0].textContent?.trim()).toBe(name);
      expect(field.getAttribute("aria-required")).toBe("true");
      expect(field.autocomplete).toBe(`section-attendee-0 ${autofill}`);
    }
    expect(input("Phone (optional)").type).toBe("tel");
    expect(input("Phone (optional)").autocomplete).toBe("section-attendee-0 tel");
    expect(input("Dietary requirements or accessibility needs (optional)").labels?.length).toBe(1);
    expect(
      screen.getByRole("button", { name: "This pass is for me" }).getAttribute("aria-pressed"),
    ).toBe("true");

    await continueToFirstError();

    for (const [name, message] of requiredFields) {
      const field = input(name);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      const errorId = field.getAttribute("aria-describedby");
      expect(document.getElementById(errorId!)?.textContent).toBe(message);
    }
    const consent = screen.getByRole("checkbox", { name: /I understand how my data/ });
    expect(consent.getAttribute("aria-required")).toBe("true");
    expect(consent.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(consent.getAttribute("aria-describedby")!)?.textContent).toBe(
      "You must agree to the terms",
    );
    fireEvent.click(screen.getByText(/I understand how my data/));
    expect(consent.getAttribute("aria-checked")).toBe("true");

    change("First Name *", "Alex");
    expect(input("First Name *").id).toBe(ids[0]);
    expect(
      screen.getByRole("button", { name: "This pass is for me" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps TBC passes optional and preserves their existing submission behaviour", async () => {
    const onAdvance = vi.fn();
    render(<Step3Attendees booking={makeBooking(2)} onAdvance={onAdvance} />);
    fireEvent.click(screen.getByRole("button", { name: /^Attendee 2/ }));
    const tbc = screen.getByRole("button", { name: "Not confirmed yet (TBC)" });
    expect(tbc.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(tbc);
    expect(tbc.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
    });

    expect(mocks.createAttendee).toHaveBeenCalledWith({
      bookingId: 20,
      data: {
        isLead: false,
        isTbc: true,
        gdprConsent: false,
        company: "Example company",
        seatIndex: 1,
      },
    });
    expect(mocks.updateAttendee).toHaveBeenCalledWith({
      bookingId: 20,
      attendeeId: 101,
      data: expect.objectContaining({ firstName: "Alex", workEmail: "alex@example.com" }),
    });
    expect(mocks.updateBooking).toHaveBeenCalledWith({ id: 20, data: { currentStep: 4 } });
    expect(onAdvance).toHaveBeenCalledWith(4);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
