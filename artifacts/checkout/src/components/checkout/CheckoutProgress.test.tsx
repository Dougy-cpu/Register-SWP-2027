// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CheckoutProgress from "./CheckoutProgress";

afterEach(() => cleanup());

describe("<CheckoutProgress />", () => {
  it("shows all four checkout steps and identifies the current step", () => {
    render(<CheckoutProgress currentStep={2} />);

    expect(screen.getByRole("navigation", { name: "Checkout progress" })).toBeTruthy();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByText("Your details")).toBeTruthy();
    expect(screen.getAllByText("Passes")).toHaveLength(2);
    expect(screen.getByText("Attendees")).toBeTruthy();
    expect(screen.getByText("Payment")).toBeTruthy();
    expect(
      screen
        .getByRole("navigation", { name: "Checkout progress" })
        .querySelector("[aria-current='step']")?.textContent,
    ).toContain("Passes");
  });

  it("does not render checkout progress after registration is complete", () => {
    const { container } = render(<CheckoutProgress currentStep={5} />);

    expect(container.childElementCount).toBe(0);
  });
});
