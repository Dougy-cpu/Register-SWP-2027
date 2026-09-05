import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import logoUrl from "@assets/swp-summit-logo.png";
import AdminLogin from "./login";

const { login, navigate } = vi.hoisted(() => ({ login: vi.fn(), navigate: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useAdminLogin: () => ({ mutateAsync: login, isPending: false }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/admin/login", navigate] }));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Live requests forbidden in tests"))),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Admin login", () => {
  it("uses the shared SWP Summit logo with an accessible brand name", () => {
    render(<AdminLogin />);
    const logo = screen.getByRole("img", { name: "SWP Summit" });
    expect(logo.getAttribute("src")).toBe(logoUrl);
    expect(screen.getByRole("heading", { name: "Admin Panel" })).toBeTruthy();
  });

  it("keeps password login and the admin redirect unchanged", async () => {
    login.mockResolvedValue({ token: "test-admin-token" });
    const { container } = render(<AdminLogin />);
    const password = container.querySelector('input[type="password"]');
    expect(password).toBeTruthy();
    fireEvent.change(password!, { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/admin"));
    expect(login).toHaveBeenCalledExactlyOnceWith({ data: { password: "test-password" } });
    expect(localStorage.getItem("admin_token")).toBe("test-admin-token");
  });
});
