import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import logoUrl from "@assets/swp-summit-logo.png";

export default function SponsorAccess() {
  const params = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/sponsor/access/${encodeURIComponent(params.token)}`, {
      method: "POST",
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "This sponsor link is not available");
        }
        navigate("/sponsor", { replace: true });
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "This sponsor link is not available"),
      );
  }, [navigate, params.token]);

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl bg-white border shadow-xl p-8 text-center">
        <img src={logoUrl} alt="SWP Summit" className="h-20 w-auto mx-auto mb-6" />
        {error ? (
          <>
            <h1 className="text-xl font-bold">Link unavailable</h1>
            <p className="text-muted-foreground mt-3">{error}</p>
            <p className="text-sm text-muted-foreground mt-4">
              Please ask your SWP Summit contact for a new private link.
            </p>
          </>
        ) : (
          <>
            <div className="h-8 w-8 mx-auto rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <h1 className="text-xl font-bold mt-5">Opening your sponsor workspace</h1>
            <p className="text-muted-foreground mt-2">This will only take a moment.</p>
          </>
        )}
      </div>
    </main>
  );
}
