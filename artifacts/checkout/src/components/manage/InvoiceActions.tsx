import { useState } from "react";
import { Download, Mail, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { customFetch } from "@workspace/api-client-react";

function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // Prefer RFC 5987 filename* (UTF-8) when present.
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

interface Props {
  token: string;
  paymentMethod: string | null;
  recipientHint?: string | null;
}

type Status = { kind: "idle" } | { kind: "ok"; message: string } | { kind: "err"; message: string };

export default function InvoiceActions({ token, paymentMethod, recipientHint }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [resending, setResending] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<Status>({ kind: "idle" });
  const [resendStatus, setResendStatus] = useState<Status>({ kind: "idle" });

  const isInvoice = paymentMethod === "invoice";
  const documentLabel = isInvoice ? "invoice" : "receipt";

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadStatus({ kind: "idle" });
    try {
      const url = `${import.meta.env.BASE_URL}api/bookings/by-management-token/${token}/invoice-pdf`;
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) {
        let message = `Could not download the ${documentLabel}. Please try again.`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          // non-JSON error body — keep default message
        }
        throw new Error(message);
      }
      const filename =
        parseFilenameFromContentDisposition(resp.headers.get("content-disposition")) ||
        `${documentLabel}.pdf`;
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDownloadStatus({ kind: "ok", message: `${filename} downloaded.` });
    } catch (err) {
      setDownloadStatus({
        kind: "err",
        message:
          err instanceof Error
            ? err.message
            : `Could not download the ${documentLabel}. Please try again.`,
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setResendStatus({ kind: "idle" });
    try {
      const result = await customFetch<{ ok: true; recipient: string }>(
        `/api/bookings/by-management-token/${token}/resend-email`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setResendStatus({
        kind: "ok",
        message: `Email sent to ${result.recipient}. Please check your inbox.`,
      });
    } catch (err) {
      setResendStatus({
        kind: "err",
        message:
          err instanceof Error
            ? err.message
            : "Could not send the email. Please try again shortly.",
      });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="border border-border bg-white rounded-sm p-5">
      <div className="flex items-start gap-3">
        <Download className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-bold capitalize">Your {documentLabel}</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Download the latest {documentLabel} PDF or have it emailed to you again.
            {recipientHint ? (
              <>
                {" "}
                Emails go to <span className="font-medium text-foreground">{recipientHint}</span>.
              </>
            ) : null}
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-3">
            <Button
              type="button"
              size="sm"
              onClick={handleDownload}
              disabled={downloading}
              className="bg-primary hover:bg-primary/90 text-white"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Preparing…
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Download {documentLabel} (PDF)
                </>
              )}
            </Button>
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="text-sm font-semibold text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-60 disabled:no-underline inline-flex items-center gap-1.5"
            >
              {resending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Mail className="w-3.5 h-3.5" />
              )}
              Email me the {documentLabel} again
            </button>
          </div>

          {downloadStatus.kind === "ok" && (
            <p className="text-xs text-green-700 flex items-center gap-1.5 mt-2">
              <CheckCircle2 className="w-3.5 h-3.5" /> {downloadStatus.message}
            </p>
          )}
          {downloadStatus.kind === "err" && (
            <p className="text-xs text-red-600 flex items-center gap-1.5 mt-2">
              <AlertCircle className="w-3.5 h-3.5" /> {downloadStatus.message}
            </p>
          )}
          {resendStatus.kind === "ok" && (
            <p className="text-xs text-green-700 flex items-center gap-1.5 mt-2">
              <CheckCircle2 className="w-3.5 h-3.5" /> {resendStatus.message}
            </p>
          )}
          {resendStatus.kind === "err" && (
            <p className="text-xs text-red-600 flex items-center gap-1.5 mt-2">
              <AlertCircle className="w-3.5 h-3.5" /> {resendStatus.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
