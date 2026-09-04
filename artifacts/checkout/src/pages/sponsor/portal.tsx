import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, CheckCircle2, LogOut, QrCode } from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorAsset, SponsorSession, SponsorWorkspace } from "@/types/sponsor";
import { PortalEvent } from "./portal-event";
import {
  formatPortalDate,
  preparationSteps,
  sessionName,
  sessionStatusLabel,
  type PortalSection,
  type PortalStep,
} from "./portal-helpers";
import { PortalSession } from "./portal-session";
import { PortalTeam } from "./portal-team";
import { InlineError } from "./portal-ui";

export default function SponsorPortal() {
  const [, navigate] = useLocation();
  const [workspace, setWorkspace] = useState<SponsorWorkspace | null>(null);
  const [section, setSection] = useState<PortalSection>("home");
  const [selectedSession, setSelectedSession] = useState<number | null>(null);
  const [editSocialBookingId, setEditSocialBookingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setLoading(true);
    try {
      const data = await sponsorJson<SponsorWorkspace>("/api/sponsor/workspace", {
        signal: AbortSignal.timeout(20_000),
      });
      if (request !== latestRequest.current) return;
      setWorkspace(data);
      setError("");
    } catch (caught) {
      if (request !== latestRequest.current) return;
      setError(
        caught instanceof Error && caught.name !== "TimeoutError"
          ? caught.message
          : "Your workspace is taking too long to respond. Check your connection and try again.",
      );
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, []);
  const invalidateRequests = useCallback(() => {
    latestRequest.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidateRequests;
  }, [load, invalidateRequests]);

  const openSection = (next: PortalSection, target?: string) => {
    setSection(next);
    if (next !== "team") setEditSocialBookingId(null);
    requestAnimationFrame(() =>
      document.getElementById(target ?? "portal-content")?.scrollIntoView({ block: "start" }),
    );
  };
  const openStep = (step: PortalStep) => {
    if (step.sessionId) setSelectedSession(step.sessionId);
    openSection(step.section, step.target);
  };
  const saved = (session: SponsorSession) => {
    latestRequest.current++;
    setLoading(false);
    setWorkspace((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((item) => (item.id === session.id ? session : item)),
          }
        : current,
    );
  };
  const uploaded = (asset: SponsorAsset) => {
    setWorkspace((current) =>
      current
        ? { ...current, assets: [asset, ...current.assets.filter((item) => item.id !== asset.id)] }
        : current,
    );
    void load();
  };
  const logout = async () => {
    if (
      signingOut ||
      !window.confirm(
        "Sign out of your sponsor workspace? Session drafts stay on this device for next time. If a draft has not finished syncing, reopen this workspace on the same device to recover it.",
      )
    )
      return;
    setSigningOut(true);
    try {
      await sponsorJson("/api/sponsor/logout", { method: "POST", body: "{}" });
      try {
        const prefix = `swp:sponsor:${workspace?.sponsor.id}:session:`;
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith(prefix) && key.endsWith(":draft")) sessionStorage.removeItem(key);
      } catch {
        /* Signing out must still work if browser storage is unavailable. */
      }
      navigate("/");
    } catch {
      setError("You could not be signed out. Check your connection and try again.");
    } finally {
      setSigningOut(false);
    }
  };

  if (!workspace)
    return (
      <main className="min-h-screen bg-[#f0f6ff] p-5">
        <Card className="mx-auto mt-12 max-w-lg space-y-5 p-6">
          <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto" />
          <h1 className="text-2xl font-bold">Your sponsor workspace</h1>
          {loading ? (
            <p role="status">Opening your workspace…</p>
          ) : (
            <>
              <InlineError message={error} />
              <p className="text-sm text-muted-foreground">
                If your access has expired, reopen the private sponsor link in your welcome email.
                If you cannot find it, contact the event team for a fresh link.
              </p>
              <Button className="min-h-11" onClick={() => void load()}>
                Try again
              </Button>
            </>
          )}
        </Card>
      </main>
    );

  const steps = preparationSteps(workspace);
  const todo = steps.filter((step) => step.state === "todo");
  const waiting = steps.filter((step) => step.state === "waiting");
  const complete = steps.filter((step) => step.state === "complete");
  const session = workspace.sessions.find((item) => item.id === selectedSession);
  return (
    <div className="min-h-screen bg-[#f0f6ff] text-foreground">
      <Tabs value={section} onValueChange={(value) => openSection(value as PortalSection)}>
        <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <img src={logoUrl} alt="SWP Summit" className="h-9 w-auto shrink-0 sm:h-11" />
                <div className="min-w-0 border-l pl-3">
                  <p className="truncate text-sm font-semibold sm:text-base">
                    {workspace.sponsor.company}
                  </p>
                  <p className="text-xs text-muted-foreground">Sponsor workspace</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label="Sign out"
                disabled={signingOut}
                onClick={() => void logout()}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
            <TabsList
              aria-label="Sponsor workspace sections"
              className="mb-3 grid h-auto w-full grid-cols-4 gap-1 bg-slate-100 p-1"
            >
              {(
                [
                  ["home", "Home"],
                  ["team", "Team & passes"],
                  ["sessions", "Sessions"],
                  ["event", "Event details"],
                ] as const
              ).map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="min-h-11 whitespace-normal px-1 text-xs sm:text-sm"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </header>
        <main
          id="portal-content"
          className="mx-auto max-w-5xl scroll-mt-40 space-y-5 px-4 py-6 sm:px-6 sm:py-8"
        >
          {error && (
            <div className="space-y-2">
              <InlineError message={error} />
              <p className="text-sm text-muted-foreground">
                Your open forms are still here. Retry to refresh saved information.
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? "Retrying…" : "Retry refresh"}
              </Button>
            </div>
          )}
          <TabsContent
            value="home"
            forceMount
            hidden={section !== "home"}
            className="mt-0 space-y-6"
          >
            <div>
              <p className="text-sm font-semibold text-primary">{workspace.sponsor.packageLabel}</p>
              <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
                Let's get you ready for the Summit
              </h1>
              <p className="mt-2 text-muted-foreground">
                Everything you need to prepare your sponsorship, in one place.
              </p>
            </div>
            {steps.length > 0 && (
              <div className="max-w-lg space-y-2">
                <p className="text-sm text-muted-foreground">
                  {complete.length} of {steps.length} preparation steps complete
                  {waiting.length ? ` · ${waiting.length} with the event team` : ""}
                </p>
                <Progress
                  value={(complete.length / steps.length) * 100}
                  aria-label="Sponsor preparation progress"
                />
              </div>
            )}
            <section aria-labelledby="next-steps-heading" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 id="next-steps-heading" className="text-xl font-semibold">
                  Your next steps
                </h2>
                {todo.length > 0 && (
                  <span className="text-sm text-muted-foreground">{todo.length} to do</span>
                )}
              </div>
              {todo.length ? (
                todo.map((step) => (
                  <StepCard key={step.key} step={step} onOpen={() => openStep(step)} />
                ))
              ) : (
                <Card className="flex gap-3 border-emerald-200 p-5">
                  <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-emerald-700" />
                  <div>
                    <h3 className="font-semibold">You're up to date</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {waiting.length
                        ? "Your submitted items are with the event team. There is nothing else to do right now."
                        : "You can still update your team, sessions or event details using the sections above."}
                    </p>
                  </div>
                </Card>
              )}
            </section>
            {waiting.length > 0 && (
              <section aria-labelledby="waiting-heading" className="space-y-3">
                <h2 id="waiting-heading" className="text-lg font-semibold">
                  With the event team
                </h2>
                {waiting.map((step) => (
                  <StepCard key={step.key} step={step} onOpen={() => openStep(step)} />
                ))}
              </section>
            )}
            {complete.length > 0 && (
              <details className="rounded-xl border bg-white p-5">
                <summary className="cursor-pointer py-1 font-semibold">
                  Completed ({complete.length})
                </summary>
                <div className="mt-3 space-y-2">
                  {complete.map((step) => (
                    <button
                      key={step.key}
                      className="flex min-h-11 w-full items-center gap-3 rounded-lg p-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => openStep(step)}
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                      {step.title}
                      <span className="ml-auto text-primary">View</span>
                    </button>
                  ))}
                </div>
              </details>
            )}
          </TabsContent>
          <TabsContent value="team" forceMount hidden={section !== "team"} className="mt-0">
            <PortalTeam
              workspace={workspace}
              onRefresh={load}
              editSocialBookingId={editSocialBookingId}
            />
          </TabsContent>
          <TabsContent value="sessions" forceMount hidden={section !== "sessions"} className="mt-0">
            {session ? (
              <PortalSession
                key={session.id}
                sponsorId={workspace.sponsor.id}
                session={session}
                assets={workspace.assets}
                onSaved={saved}
                onUploaded={uploaded}
                onRefresh={load}
                onBack={() => {
                  setSelectedSession(null);
                  openSection("sessions");
                }}
              />
            ) : (
              <section aria-labelledby="sessions-heading" className="space-y-5">
                <div>
                  <h2 id="sessions-heading" className="text-2xl font-bold">
                    Your sessions
                  </h2>
                  <p className="mt-2 text-muted-foreground">
                    Each speaking slot has its own details, speakers, photos and slides.
                  </p>
                </div>
                {workspace.sessions.map((item) => (
                  <Card
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-4 p-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-primary">
                        {sessionStatusLabel(item)}
                      </p>
                      <h3 className="mt-1 font-semibold">{sessionName(item)}</h3>
                      <p className="mt-1 break-words text-sm text-muted-foreground">
                        {item.title || "Add your session title and speaker details."}
                      </p>
                      {item.feedback && (
                        <p className="mt-2 text-sm text-amber-900">
                          The event team has left feedback for you.
                        </p>
                      )}
                    </div>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      aria-label={`Open ${sessionName(item)}`}
                      onClick={() => {
                        setSelectedSession(item.id);
                        openSection("sessions");
                      }}
                    >
                      Open session
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Card>
                ))}
                {!workspace.sessions.length && (
                  <Card className="p-5 text-sm text-muted-foreground">
                    No speaking slots are listed yet. If your package includes a session, the event
                    team will add it here.
                  </Card>
                )}
              </section>
            )}
          </TabsContent>
          <TabsContent value="event" forceMount hidden={section !== "event"} className="mt-0">
            <PortalEvent
              workspace={workspace}
              onRefresh={load}
              onUploaded={uploaded}
              onEditSocial={(bookingId) => {
                setEditSocialBookingId(bookingId);
                openSection("team");
              }}
            />
          </TabsContent>
          <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-4 text-sm text-muted-foreground">
            <span className="font-medium">At the event</span>
            <Link
              href="/sponsor/scanner"
              className="inline-flex min-h-11 items-center gap-2 text-primary"
            >
              <QrCode className="h-4 w-4" />
              Scan badges
            </Link>
            <Link
              href="/sponsor/leads?organiser=1"
              className="inline-flex min-h-11 items-center text-primary"
            >
              View leads
            </Link>
          </footer>
        </main>
      </Tabs>
    </div>
  );
}

function StepCard({ step, onOpen }: { step: PortalStep; onOpen: () => void }) {
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between gap-4 p-5 text-left transition-colors hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <div className="min-w-0">
          <h3 className="font-semibold">{step.title}</h3>
          <p className="mt-1 break-words text-sm text-muted-foreground">{step.detail}</p>
          {step.dueAt && step.state === "todo" && (
            <p className="mt-2 text-xs font-medium text-primary">
              Due {formatPortalDate(step.dueAt)}
            </p>
          )}
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-primary" />
      </button>
    </Card>
  );
}
