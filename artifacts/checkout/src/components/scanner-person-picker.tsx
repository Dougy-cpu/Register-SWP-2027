import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  approvedProfiles,
  getScannerCredential,
  readScannerValue,
  saveScannerCredential,
} from "@/lib/scanner-storage";
import { boundedSignal, importScannerLink, ScannerApiError } from "@/lib/scanner-api";
import type { ScannerBootstrap, ScannerCredential } from "@/types/lead-scanner";

type Member = { id: string; name: string };
async function publicPost<T>(route: string, body: unknown): Promise<T> {
  const r = await fetch("/api/scanner-team/" + route, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    signal: boundedSignal(),
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ScannerApiError(data.error ?? "Unable to open this team link.", r.status);
  return data as T;
}
export function ScannerPersonPicker({
  companyKey,
  current,
  onDone,
  onCancel,
}: {
  companyKey: string;
  current?: ScannerCredential | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]),
    [saved, setSaved] = useState<ScannerCredential[]>([]),
    [company, setCompany] = useState(""),
    [selected, setSelected] = useState<Member | null>(null);
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      let local: ScannerCredential[] = [];
      try {
        const id = Number(companyKey.split(".")[0]);
        if (!Number.isSafeInteger(id) || id < 1)
          throw new Error("Open the private company scanner link from your coordinator.");
        const checked = await Promise.all(
          (await approvedProfiles(id)).map(async (p) => {
            const state = await readScannerValue<ScannerBootstrap>("bootstrap", p);
            return state?.companyKey === companyKey &&
              !(await readScannerValue<string>("access-error", p))
              ? p
              : null;
          }),
        );
        local = checked.filter((p): p is ScannerCredential => !!p);
        if (!current && local.length) {
          const active = await getScannerCredential();
          if (alive && local.some((p) => p.id === active?.id && p.token === active.token)) {
            onDone();
            return;
          }
        }
        if (alive && local.length) {
          setSaved(local);
          setMembers(local.map((p) => ({ id: p.id, name: p.operatorName })));
          setCompany(local[0].sponsorCompany);
          setLoading(false);
        }
        const roster = await publicPost<{
          sponsorId: number;
          sponsorCompany: string;
          staff: Member[];
        }>("roster", { companyKey });
        if (roster.sponsorId !== id) throw new Error("The company link could not be verified.");
        if (alive) {
          setCompany(roster.sponsorCompany);
          setMembers(roster.staff);
          setSaved(local.filter((p) => roster.staff.some((m) => m.id === p.id)));
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof ScannerApiError && [401, 403].includes(e.status)) {
          setSaved([]);
          setMembers([]);
          setError(e.message);
        } else
          setError(
            local.length
              ? "Offline: choose a person already set up on this device."
              : "Connect to the internet to open this company link for the first time.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [companyKey, current, onDone]);
  async function choose(m: Member) {
    if (busy) return;
    setError("");
    const known = saved.find((p) => p.id === m.id);
    if (!known) {
      setSelected(m);
      setPin("");
      return;
    }
    setBusy(true);
    try {
      if (navigator.onLine) {
        try {
          await importScannerLink(known.token, false);
        } catch (e) {
          if (
            e instanceof ScannerApiError ||
            !(e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError"))
          )
            throw e;
          await saveScannerCredential(known);
        }
      } else await saveScannerCredential(known);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to switch person.");
    } finally {
      setBusy(false);
    }
  }
  async function join() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const c = await publicPost<ScannerCredential>("access", {
        companyKey,
        repId: selected.id,
        pin,
      });
      if (c.id !== selected.id || c.sponsorId !== Number(companyKey.split(".")[0]))
        throw new Error("This scanner does not match your selection.");
      await importScannerLink(c.token, false);
      onDone();
    } catch (e) {
      setError(
        e instanceof ScannerApiError
          ? e.message
          : "Connect to the internet for first setup, or open your personal link.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-slate-50 p-4">
      <Card className="mx-auto mt-6 max-w-md space-y-4 p-5">
        <p className="text-sm font-semibold text-primary">{company || "Sponsor scanner"}</p>
        <h1 className="text-2xl font-bold">
          {selected ? "Scan as " + selected.name : "Who’s scanning?"}
        </h1>
        {error && (
          <p role="status" className="text-sm text-slate-700">
            {error}
          </p>
        )}
        {loading ? (
          <p>Opening the team list…</p>
        ) : selected ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <Label htmlFor="rep-code">Your private rep code</Label>
            <Input
              id="rep-code"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              maxLength={8}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
            <p className="text-sm text-slate-600">
              Use the code from your coordinator once on this device, or open your personal scanner
              link.
            </p>
            <Button className="min-h-12 w-full" disabled={busy || pin.length !== 8}>
              Continue as {selected.name}
            </Button>
            <Button type="button" variant="outline" onClick={() => setSelected(null)}>
              Choose another person
            </Button>
          </form>
        ) : (
          <>
            {!members.length && !error && (
              <p>
                No registered scanning staff yet. Ask your coordinator to register the stand team.
              </p>
            )}
            {members.map((m) => (
              <Button
                key={m.id}
                disabled={busy}
                variant="outline"
                className="min-h-12 w-full justify-between"
                onClick={() => void choose(m)}
              >
                <span>
                  {m.name}
                  {members.some((other) => other.id !== m.id && other.name === m.name) &&
                    " · Staff #" + m.id.split("-").at(-1)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {saved.some((p) => p.id === m.id) ? "Ready here" : "Set up"}
                </span>
              </Button>
            ))}
          </>
        )}
        {current && onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Back to {current.operatorName}
          </Button>
        )}
      </Card>
    </main>
  );
}
