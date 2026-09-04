import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { adminJson } from "@/lib/admin-api";
import type { SponsorWorkspace } from "@/types/sponsor";

export function SponsorRequests({
  workspace,
  onRefresh,
}: {
  workspace: SponsorWorkspace;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const resolve = async (
    request: NonNullable<SponsorWorkspace["passRequests"]>[number],
    decision: "approved" | "declined",
  ) => {
    if (busy) return;
    if (
      !window.confirm(
        decision === "approved"
          ? `Add ${request.requestedVip} VIP and ${request.requestedStaff} staff places to ${workspace.company}?`
          : "Decline this request? The sponsor will see this decision in their workspace.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await adminJson(`/api/admin/sponsors/${workspace.id}/pass-requests/${request.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await onRefresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The decision could not be saved. Refresh and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">Pass requests</h2>
      <p className="text-sm text-muted-foreground">
        Approval adds the requested places once. The sponsor sees the decision and updated
        allocation in Team & passes.
      </p>
      {error && (
        <p role="alert" className="text-rose-800">
          {error}
        </p>
      )}
      {(workspace.passRequests ?? []).map((request) => (
        <Card key={request.id} className="p-5 space-y-3">
          <div className="flex justify-between gap-4">
            <h3 className="font-semibold">
              {request.requestedVip} additional VIP / {request.requestedStaff} additional staff
            </h3>
            <span className="text-sm">
              {request.status === "open"
                ? "Awaiting decision"
                : request.status === "resolved"
                  ? "Approved"
                  : "Declined"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Requested {new Date(request.createdAt).toLocaleString("en-GB")}
          </p>
          {request.message && <p className="whitespace-pre-wrap text-sm">{request.message}</p>}
          {request.status === "open" && (
            <div className="flex gap-3">
              <Button disabled={busy} onClick={() => void resolve(request, "approved")}>
                Approve and add places
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void resolve(request, "declined")}
              >
                Decline
              </Button>
            </div>
          )}
        </Card>
      ))}
      {!workspace.passRequests?.length && (
        <Card className="p-5 text-sm">No pass requests yet.</Card>
      )}
    </div>
  );
}
