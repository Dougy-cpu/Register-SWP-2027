import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SponsorStaff } from "@/types/sponsor";
import { sponsorJson } from "@/lib/sponsor-api";

type Member = { id: string; name: string };
type Device = {
  id: string;
  operatorName: string;
  revokedAt: string | null;
  lastSyncedAt: string | null;
  needsRefresh: boolean;
};
type Grant = { id: string; token: string; operatorName: string; pin?: string };
const href = (key: string, value: string) =>
  window.location.origin + "/sponsor/scanner#" + key + "=" + encodeURIComponent(value);
export function PortalScannerAccess({ staff }: { staff: SponsorStaff[] }) {
  const [team, setTeam] = useState<{ companyKey: string; staff: Member[] } | null>(null),
    [devices, setDevices] = useState<Device[]>([]);
  const [grant, setGrant] = useState<Grant | null>(null),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  async function load() {
    try {
      const [t, d] = await Promise.all([
        sponsorJson<{ companyKey: string; staff: Member[] }>("/api/sponsor/scanner/team"),
        sponsorJson<{ devices: Device[] }>("/api/sponsor/scanner/devices"),
      ]);
      setTeam(t);
      setDevices(d.devices);
      setError("");
    } catch {
      setError("Team scanners could not be loaded. Try again.");
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open, staff]);
  async function copy(url: string, who: string) {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Copied " + who + "’s scanner link.");
    } catch {
      setStatus("Select the private link and copy it manually.");
    }
  }
  async function issue(member: Member, renew = false) {
    if (busy) return;
    if (
      renew &&
      !window.confirm(
        "Replace " +
          member.name +
          "’s scanner access? Their previous link and code will stop working. Saved scans remain on each original device.",
      )
    )
      return;
    setBusy(true);
    setError("");
    setStatus("");
    setGrant(null);
    try {
      const fresh = await sponsorJson<Grant>(
        "/api/sponsor/scanner/team/" + encodeURIComponent(member.id),
        { method: "POST", body: JSON.stringify({ renew }) },
      );
      setGrant(fresh);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare access.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      id="team-scanners"
      className="rounded-xl border bg-white p-5 scroll-mt-32"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="font-semibold cursor-pointer min-h-11 py-2">Set up team scanners</summary>
      <div className="mt-3 space-y-4">
        <p>
          Give each rep their personal link, or share the company link and give each rep their own
          code. Keep your management link private.
        </p>
        {error && (
          <p role="alert">
            {error}{" "}
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </p>
        )}
        {team && (
          <>
            <div className="rounded-lg bg-blue-50 p-4 space-y-2">
              <h3 className="font-bold">Company scanner link</h3>
              <p className="text-sm">
                Staff choose their name. Use their private code the first time on a new device.
              </p>
              <Input
                readOnly
                aria-label="Company scanner link"
                onFocus={(e) => e.target.select()}
                value={href("team", team.companyKey)}
              />
              <Button
                variant="outline"
                onClick={() => void copy(href("team", team.companyKey), "the team")}
              >
                Copy company link
              </Button>
            </div>
            {!team.staff.length && (
              <p>
                Register the people working your stand in Team &amp; passes. Their scanners appear
                here.
              </p>
            )}
            {team.staff.map((m) => {
              const d = devices.find((x) => x.id === m.id),
                renew = !!(d?.revokedAt || d?.needsRefresh);
              return (
                <div key={m.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">
                        {m.name}{" "}
                        {team.staff.some((other) => other.id !== m.id && other.name === m.name) && (
                          <span className="text-sm">· Staff #{m.id.split("-").at(-1)}</span>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {renew
                          ? "Access needs renewing"
                          : d?.lastSyncedAt
                            ? "Last backup: " +
                              new Date(d.lastSyncedAt).toLocaleString("en-GB", {
                                timeZone: "Europe/London",
                              })
                            : "Not yet synced"}
                      </p>
                    </div>
                    <Button
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => void issue(m, renew)}
                    >
                      {renew ? "Renew " + m.name + "’s access" : "Share " + m.name + "’s scanner"}
                    </Button>
                  </div>
                  {grant?.id === m.id && (
                    <div className="space-y-2 border-t pt-3">
                      <p>
                        <b>{m.name}’s private scanner</b>
                      </p>
                      <Input
                        aria-label={m.name + "’s private scanner link"}
                        readOnly
                        value={href("activate", grant.token)}
                        onFocus={(e) => e.target.select()}
                      />
                      <p className="text-sm">
                        Keep this message. Reopen it on the same phone or iPad. Private company-link
                        code: <b>{grant.pin}</b>.
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => void copy(href("activate", grant.token), m.name)}
                      >
                        Copy personal link
                      </Button>{" "}
                      {typeof navigator.share === "function" && (
                        <Button
                          variant="outline"
                          onClick={() =>
                            void navigator
                              .share({
                                title: m.name + "’s SWP scanner",
                                text: "Keep this message. Reopen it on the same phone or iPad.",
                                url: href("activate", grant.token),
                              })
                              .catch((e: Error) => {
                                if (e.name !== "AbortError")
                                  setError("Use Copy personal link to share.");
                              })
                          }
                        >
                          Share link
                        </Button>
                      )}
                      <details>
                        <summary className="text-sm cursor-pointer py-2">
                          Lost device or forwarded link?
                        </summary>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void issue(m, true)}
                        >
                          Replace link and code
                        </Button>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
            {devices
              .filter((d) => !d.id.startsWith("rep-"))
              .map((d) => (
                <div key={d.id} className="border rounded p-3">
                  <p>{d.operatorName} · existing scanner</p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Replace this existing link? Its old link will stop working.",
                        )
                      )
                        return;
                      setBusy(true);
                      void sponsorJson<Grant>(
                        "/api/sponsor/scanner/devices/" + encodeURIComponent(d.id) + "/restore",
                        { method: "POST", body: "{}" },
                      )
                        .then(setGrant)
                        .catch(() => setError("Could not renew access."))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Renew existing link
                  </Button>
                  {grant?.id === d.id && (
                    <Input
                      aria-label="Replacement scanner link"
                      readOnly
                      onFocus={(e) => e.target.select()}
                      value={href("activate", grant.token)}
                    />
                  )}
                </div>
              ))}
          </>
        )}
        {status && (
          <p role="status" className="text-sm font-medium text-primary">
            {status}
          </p>
        )}
      </div>
    </details>
  );
}
