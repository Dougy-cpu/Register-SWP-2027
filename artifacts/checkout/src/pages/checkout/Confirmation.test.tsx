import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BookingWithAttendees } from "@/types/booking";
import Confirmation from "./Confirmation";

describe("<Confirmation />", () => {
  it("renders TBC attendees without requiring name fields", () => {
    const booking = {
      id: 1,
      status: "invoiced",
      paymentMethod: "invoice",
      passType: "business",
      quantity: 2,
      totalAmount: 1293.84,
      orderReference: "SWP27-7002",
      invoiceBadgeStatus: "sent",
      attendees: [
        {
          id: 1,
          seatIndex: 0,
          isLead: true,
          isTbc: false,
          firstName: "Taylor",
          lastName: "Reed",
          workEmail: "taylor.reed@example.com",
        },
        {
          id: 2,
          seatIndex: 1,
          isLead: false,
          isTbc: true,
          firstName: null,
          lastName: null,
          workEmail: null,
        },
      ],
    } as unknown as BookingWithAttendees;

    render(<Confirmation booking={booking} />);

    expect(screen.getByRole("heading", { name: "You are registered!" })).toBeTruthy();
    expect(screen.getByText("Attendee 2 (TBC)")).toBeTruthy();
  });
});
