import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PhoneScannerLink({ url }: { url: string }) {
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      if (mounted.current) setStatus("Link copied. Paste it into your phone browser.");
    } catch {
      if (mounted.current)
        setStatus("Select and copy the full link below, then paste it into your phone browser.");
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-base text-slate-700">
        Copy this link and paste it into your phone browser.
      </p>
      <p
        className="select-all break-all rounded-lg border border-blue-200 bg-white p-4 text-base font-semibold text-primary"
        tabIndex={0}
        aria-label="Phone scanner URL"
      >
        {url}
      </p>
      <Button className="h-12 px-6 text-base" onClick={() => void copy()}>
        {status.startsWith("Link copied") ? (
          <Check className="h-5 w-5" />
        ) : (
          <Copy className="h-5 w-5" />
        )}
        Copy link
      </Button>
      {status && (
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      )}
    </div>
  );
}
