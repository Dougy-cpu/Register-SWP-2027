import { useRef, useState } from "react";
import { CheckCircle2, Download, FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorAsset, SponsorAssetCategory, SponsorDocument } from "@/types/sponsor";

export function InlineError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      {message}
    </p>
  ) : null;
}

export function UploadField({
  label,
  category,
  files,
  sessionId,
  presenterId,
  prepare,
  onUploaded,
  disabled = false,
  hint,
  onBusyChange,
}: {
  label: string;
  category: SponsorAssetCategory;
  files: SponsorAsset[];
  sessionId?: number;
  presenterId?: number;
  prepare?: () => Promise<{ sessionId: number; presenterId?: number }>;
  onUploaded: (asset: SponsorAsset) => void;
  disabled?: boolean;
  hint?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const replacement = useRef<string | undefined>(undefined);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const photo = category === "headshot";
  const multiple = category === "session_material" || category === "other";
  const accept = photo
    ? ".png,.jpg,.jpeg,.webp"
    : ".png,.jpg,.jpeg,.webp,.svg,.eps,.ai,.pdf,.pptx,.docx";
  const upload = async (file: File) => {
    if (operation.current) return;
    setError("");
    setNotice("");
    const raster = /\.(png|jpe?g|webp)$/i.test(file.name);
    const maximum = raster ? 10 : 25;
    if (photo && !raster) {
      setError("Choose a PNG, JPG or WebP photo.");
      return;
    }
    if (file.size > maximum * 1024 * 1024) {
      setError(`Choose a file smaller than ${maximum} MB.`);
      return;
    }
    operation.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const relationship = prepare ? await prepare() : { sessionId, presenterId };
      const body = new FormData();
      body.append("file", file);
      body.append("category", category);
      if (relationship.sessionId) body.append("sessionId", String(relationship.sessionId));
      if (relationship.presenterId) body.append("presenterId", String(relationship.presenterId));
      const asset = await sponsorJson<SponsorAsset>(
        replacement.current
          ? `/api/sponsor/assets/${replacement.current}/replace`
          : "/api/sponsor/assets",
        { method: "POST", body },
      );
      onUploaded(asset);
      setNotice("Uploaded successfully");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The upload could not be completed. Try again.",
      );
    } finally {
      operation.current = false;
      setBusy(false);
      onBusyChange?.(false);
      replacement.current = undefined;
      if (input.current) input.current.value = "";
    }
  };
  const choose = (assetId?: string) => {
    replacement.current = assetId;
    input.current?.click();
  };
  return (
    <div className="space-y-3">
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={accept}
        aria-label={label}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
          event.currentTarget.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy || disabled}
          onClick={() => choose(multiple ? undefined : files[0]?.id)}
        >
          <Upload className="mr-2 h-4 w-4" />
          {busy
            ? "Uploading…"
            : files.length && !multiple
              ? label.replace(/^Upload/, "Replace")
              : label}
        </Button>
        <span className="text-xs text-muted-foreground">
          {hint ??
            (photo
              ? "PNG, JPG or WebP · up to 10 MB"
              : "Images up to 10 MB · documents up to 25 MB")}
        </span>
      </div>
      {files.map((asset) => (
        <div
          key={asset.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white p-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
            <span className="min-w-0 break-words text-sm">{asset.originalName}</span>
          </div>
          {multiple && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy || disabled}
              aria-label={`Replace ${asset.originalName}`}
              onClick={() => choose(asset.id)}
            >
              Replace
            </Button>
          )}
          <a
            href={`/api/sponsor/assets/${asset.id}/download`}
            className="inline-flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            aria-label={`Download ${asset.originalName}`}
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </div>
      ))}
      <InlineError message={error} />
      {notice && (
        <p role="status" className="text-sm text-emerald-800">
          {notice}
        </p>
      )}
    </div>
  );
}

export function EventDocument({
  document,
  available,
  onAcknowledged,
}: {
  document: SponsorDocument;
  available: boolean;
  onAcknowledged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const acknowledge = async () => {
    setBusy(true);
    setError("");
    try {
      await sponsorJson(`/api/sponsor/documents/${document.id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ acknowledgedBy: name.trim() }),
      });
      await onAcknowledged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your confirmation could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          {document.title}
        </h3>
        <span className="text-xs text-muted-foreground">
          {document.required ? "Required" : "Optional"}
        </span>
      </div>
      {!available ? (
        <p role="alert" className="text-sm text-amber-900">
          This document is temporarily unavailable. The event team needs to restore it before you
          can confirm it.
        </p>
      ) : (
        <>
          <a
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary underline"
            href={`/api/sponsor/assets/${document.assetId}/download`}
          >
            <Download className="h-4 w-4" />
            Download document
          </a>
          {document.acknowledged ? (
            <p className="flex items-center gap-2 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              Confirmed by {document.acknowledgedBy}
            </p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void acknowledge();
              }}
            >
              <div className="min-w-0 flex-1">
                <Label htmlFor={`document-${document.id}-name`}>Your name</Label>
                <Input
                  id={`document-${document.id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={200}
                  autoComplete="name"
                />
              </div>
              <Button type="submit" className="min-h-11" disabled={busy || name.trim().length < 2}>
                {busy ? "Saving…" : "I've read this"}
              </Button>
            </form>
          )}
        </>
      )}
      <InlineError message={error} />
    </div>
  );
}
