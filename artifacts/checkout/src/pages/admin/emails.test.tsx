import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateEditor } from "./emails";

const editor = vi.hoisted(() => ({
  commands: { setContent: vi.fn() },
  getHTML: vi.fn(() => "<p>Formatting removed</p>"),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock("@tiptap/react", () => ({ useEditor: () => editor, EditorContent: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("loads and saves the branded source intact without passing it through the lossy visual editor", async () => {
  const original =
    '<!-- swp-transactional-v2 -->\n<tr><td style="padding:28px 40px"><h1>Welcome, {{firstName}}</h1>{{nextStep}}</td></tr>';
  let saved: { htmlBody: string; subject: string } | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        saved = JSON.parse(String(options.body));
        return { ok: true, json: async () => saved };
      }
      if (input.includes("/preview"))
        return {
          ok: true,
          json: async () => ({ html: "<p>Rendered preview</p>", subject: "Welcome" }),
        };
      if (input.includes("/admin/registrations"))
        return { ok: true, json: async () => ({ registrations: [] }) };
      return { ok: true, json: async () => ({ subject: "Welcome", htmlBody: original }) };
    }),
  );
  render(<TemplateEditor type="welcome" />);
  const source = await screen.findByPlaceholderText(/Raw HTML/);
  expect((source as HTMLTextAreaElement).value).toBe(original);
  expect(screen.queryByTitle("Switch to Visual editor")).toBeNull();
  expect(editor.commands.setContent).not.toHaveBeenCalled();
  const edited = original.replace("Welcome,", "See you in London,");
  fireEvent.change(source, { target: { value: edited } });
  fireEvent.click(screen.getByRole("button", { name: /Save Template/i }));
  await waitFor(() => expect(saved?.htmlBody).toBe(edited));
  expect(saved?.subject).toBe("Welcome");
  expect(editor.commands.setContent).not.toHaveBeenCalled();
});
