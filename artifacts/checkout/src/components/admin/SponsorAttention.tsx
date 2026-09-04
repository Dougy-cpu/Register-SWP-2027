import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { adminJson } from "@/lib/admin-api";

export default function SponsorAttention() {
  const [items, setItems] = useState<
    Array<{ sponsorId: number; company: string; label: string; section: string }>
  >([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await adminJson<{ items: typeof items }>("/api/admin/sponsors/attention");
      setItems(result.items);
      setError("");
    } catch {
      setError("Sponsor actions could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Card className="p-5 space-y-4">
      <div className="flex justify-between gap-3">
        <h2 className="font-bold text-lg">
          Sponsor actions{items.length ? ` (${items.length})` : ""}
        </h2>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {loading ? (
        <p className="text-sm">Checking sponsor actions…</p>
      ) : error ? (
        <p role="alert" className="text-rose-800">
          {error}
        </p>
      ) : items.length ? (
        <div className="divide-y">
          {items.slice(0, 12).map((item, index) => (
            <Link
              key={`${item.sponsorId}:${index}`}
              href={`/admin/sponsors/${item.sponsorId}?section=${item.section}`}
              className="block py-3 hover:text-primary"
            >
              <p className="font-semibold text-sm">{item.company}</p>
              <p className="text-sm">{item.label} →</p>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No sponsor approvals, requests or overdue items need attention.
        </p>
      )}
      <Link href="/admin/sponsors" className="inline-block text-sm text-primary min-h-11 py-3">
        All sponsors →
      </Link>
    </Card>
  );
}
