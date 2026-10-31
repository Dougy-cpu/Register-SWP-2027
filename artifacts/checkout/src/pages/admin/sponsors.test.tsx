import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { adminJson } from "@/lib/admin-api";
import AdminSponsors from "./sponsors";

vi.mock("@/lib/admin-api", () => ({ adminJson: vi.fn() }));
vi.mock("wouter", async (original) => ({
  ...(await original<typeof import("wouter")>()),
  useLocation: () => ["/admin/sponsors", vi.fn()],
}));
afterEach(cleanup);

it("creates a draft sponsor with summit deliverables and no Community Social obligation", async () => {
  vi.mocked(adminJson).mockImplementation(async (path, options) => {
    if (options?.method === "POST") return { id: 42 };
    return path === "/api/admin/sponsors/attention" ? { items: [] } : { sponsors: [] };
  });
  render(<AdminSponsors />);
  fireEvent.click(screen.getByRole("button", { name: "Add sponsor" }));
  expect(screen.queryByText(/community social/i)).toBeNull();
  const companyGroup = screen.getByText("Company", { selector: "label" }).parentElement!;
  fireEvent.change(within(companyGroup).getByRole("textbox"), {
    target: { value: "Example Partners" },
  });
  fireEvent.change(screen.getByPlaceholderText("e.g. Gold Partner"), { target: { value: "Gold" } });
  const primary = screen.getByRole("heading", { name: "Primary contact" }).closest("section")!;
  fireEvent.change(primary.querySelector('input[type="email"]')!, {
    target: { value: "team@example.invalid" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft sponsor" }));
  await waitFor(() =>
    expect(vi.mocked(adminJson).mock.calls.some(([, req]) => req?.method === "POST")).toBe(true),
  );
  const post = vi.mocked(adminJson).mock.calls.find(([, req]) => req?.method === "POST")![1]!;
  const keys = (JSON.parse(String(post.body)).tasks as { taskKey: string }[]).map(
    (task) => task.taskKey,
  );
  expect(keys).toEqual(
    expect.arrayContaining(["staff", "sessions", "assets", "logistics", "onsite_contacts"]),
  );
  expect(keys).not.toContain("community_social");
});
