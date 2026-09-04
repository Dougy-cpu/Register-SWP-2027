import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sponsorJson } from "@/lib/sponsor-api";
import type { ScannerCredential } from "@/types/lead-scanner";

type Device = {
  id: string;
  operatorName: string;
  revokedAt: string | null;
  lastSyncedAt: string | null;
  needsRefresh: boolean;
};
export function PortalScannerAccess() {
  const [devices, setDevices] = useState<Device[]>([]),
    [name, setName] = useState("");
  const [link, setLink] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const data = await sponsorJson<{ devices: Device[] }>("/api/sponsor/scanner/devices");
    setDevices(data.devices);
  };
  const issue = async (device?: Device) => {
    if (busy || (!device && name.trim().length < 2)) return;
    if (
      device &&
      !window.confirm(
        `Restore scanner access for ${device.operatorName}? Their old link will stop working. Give them this new link to open on the same phone, so their saved leads reconnect.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setLink("");
    try {
      const result = await sponsorJson<ScannerCredential>(
        device
          ? `/api/sponsor/scanner/devices/${device.id}/restore`
          : "/api/sponsor/scanner/devices",
        {
          method: "POST",
          body: JSON.stringify(device ? {} : { operatorName: name.trim() }),
        },
      );
      setLink(
        `${window.location.origin}/sponsor/scanner#activate=${encodeURIComponent(result.token)}`,
      );
      setName("");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to create a scanner link. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="rounded-xl border bg-white p-5"
      onToggle={(event) => {
        if (event.currentTarget.open)
          void load().catch(() =>
            setError("Scanner access could not be loaded. Close and reopen this section to retry."),
          );
      }}
    >
      <summary className="font-semibold cursor-pointer py-1">Event-day scanning access</summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Create a separate link for each person scanning badges. It opens Scan and Leads only,
          without access to your sponsorship details. Do not share your management link with
          scanning staff.
        </p>
        <Label htmlFor="scanner-staff-name">Staff member's name</Label>
        <Input
          id="scanner-staff-name"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <Button disabled={busy || name.trim().length < 2} onClick={() => void issue()}>
          {busy ? "Preparing…" : "Create scanner link"}
        </Button>
        {link && (
          <Card className="p-4 space-y-3">
            <p className="text-sm">
              Copy this private link and share it with that person. Ask them to open it on their
              event-day phone before the event.
            </p>
            <Input
              readOnly
              aria-label="Private scanner link"
              value={link}
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(link)
                  .catch(() => setError("Select the link above and copy it manually."))
              }
            >
              Copy scanner link
            </Button>
          </Card>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-800">
            {error}
          </p>
        )}
        {devices.map((device) => (
          <div
            key={device.id}
            className="rounded-lg border p-3 flex flex-wrap gap-3 items-center justify-between"
          >
            <div>
              <p className="font-medium">{device.operatorName}</p>
              <p className="text-xs text-muted-foreground">
                {device.revokedAt
                  ? "Access revoked"
                  : device.needsRefresh
                    ? "Access needs renewing"
                    : device.lastSyncedAt
                      ? "Connected"
                      : "Link created · not connected yet"}
              </p>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => void issue(device)}>
              Renew link / restore phone
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}
