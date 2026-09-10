import { useEffect, useState } from "react";
import {
  cachedScannerLeads,
  pendingScannerItems,
  rejectedScannerItems,
} from "@/lib/scanner-storage";
import { mergeScannerLeads } from "@/lib/scanner-leads";
import type { ScannerCredential, SponsorLead } from "@/types/lead-scanner";
export interface ScannerSummary {
  leads: SponsorLead[];
  pendingScans: number;
  pendingNotes: number;
  rejected: number;
  error: string;
  loaded: boolean;
}
export function useScannerSummary(credential: ScannerCredential | null) {
  const [summary, setSummary] = useState<ScannerSummary>({
    leads: [],
    pendingScans: 0,
    pendingNotes: 0,
    rejected: 0,
    error: "",
    loaded: false,
  });
  useEffect(() => {
    if (!credential) return;
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const [leads, pending, rejected] = await Promise.all([
          cachedScannerLeads(credential),
          pendingScannerItems(credential),
          rejectedScannerItems(credential),
        ]);
        if (!active || current !== generation) return;
        setSummary({
          leads: mergeScannerLeads(leads, pending.scans, pending.annotations, rejected, credential),
          pendingScans: pending.scans.filter((scan) => scan.code !== "FFFFFFFFFFFF").length,
          pendingNotes: pending.annotations.length,
          rejected: rejected.length,
          error: "",
          loaded: true,
        });
      } catch {
        if (active && current === generation)
          setSummary((previous) => ({
            ...previous,
            error: "Saved totals are unavailable. Keep this page open and try again.",
            loaded: true,
          }));
      }
    };
    const changed = () => {
      void refresh();
    };
    const channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("swp-scanner-data") : null;
    if (channel) channel.onmessage = changed;
    window.addEventListener("swp:scanner-data", changed);
    window.addEventListener("focus", changed);
    void refresh();
    return () => {
      active = false;
      channel?.close();
      window.removeEventListener("swp:scanner-data", changed);
      window.removeEventListener("focus", changed);
    };
  }, [credential]);
  return summary;
}
