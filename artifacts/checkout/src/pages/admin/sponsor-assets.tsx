import { useCallback, useEffect, useState } from "react";
import { Archive, Download, FileArchive, Search, ShieldCheck } from "lucide-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminJson, downloadAdminFile } from "@/lib/admin-api";
import type { SponsorAsset, SponsorAssetCategory } from "@/types/sponsor";

const categories: Array<{ value: "all" | SponsorAssetCategory; label: string }> = [
  { value: "all", label: "All categories" },
  { value: "logo", label: "Logos" },
  { value: "headshot", label: "Headshots" },
  { value: "slides", label: "Slides" },
  { value: "session_material", label: "Session material" },
  { value: "logistics", label: "Logistics" },
  { value: "other", label: "Other" },
];

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusClass(status: string) {
  if (status === "active") return "bg-emerald-100 text-emerald-800";
  if (status === "missing") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

export default function AdminSponsorAssets() {
  const [assets, setAssets] = useState<SponsorAsset[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | SponsorAssetCategory>("all");
  const [status, setStatus] = useState<"all" | "active" | "archived" | "missing">("active");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [backupBatches, setBackupBatches] = useState<Array<{
    sponsorIds: number[];
    assetIds: string[];
    byteSize: number;
  }> | null>(null);

  const load = useCallback(
    (verify = false) => {
      setLoading(true);
      const query = new URLSearchParams();
      if (search.trim()) query.set("search", search.trim());
      if (category !== "all") query.set("category", category);
      if (status !== "all") query.set("status", status);
      if (verify) query.set("verify", "true");
      adminJson<{ assets: SponsorAsset[] }>(`/api/admin/sponsor-assets?${query}`)
        .then((data) => {
          setAssets(data.assets);
          setError("");
        })
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : "Asset library could not be loaded"),
        )
        .finally(() => {
          setLoading(false);
          setChecking(false);
        });
    },
    [category, search, status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const totalBytes = assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  const missingCount = assets.filter((asset) => asset.status === "missing").length;

  const planBackup = async () => {
    try {
      const result = await adminJson<{
        batches: Array<{ sponsorIds: number[]; assetIds: string[]; byteSize: number }>;
      }>("/api/admin/sponsor-assets/backup-plan", {
        method: "POST",
        body: JSON.stringify({ maxBytesPerZip: 500 * 1024 * 1024 }),
      });
      setBackupBatches(result.batches);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Backup could not be planned");
    }
  };

  return (
    <AdminLayout title="Sponsor Asset Library">
      <div className="space-y-6">
        <div className="flex flex-col lg:flex-row gap-4 lg:items-center lg:justify-between">
          <p className="text-muted-foreground">
            Every sponsor file is served privately from Replit App Storage.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setChecking(true);
                load(true);
              }}
              disabled={checking}
            >
              <ShieldCheck className="h-4 w-4 mr-2" />
              {checking ? "Checking…" : "Check storage"}
            </Button>
            <Button onClick={planBackup}>
              <Archive className="h-4 w-4 mr-2" /> Plan complete backup
            </Button>
          </div>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <Card className="p-5">
            <p className="text-xs uppercase font-bold text-muted-foreground">Files in view</p>
            <p className="text-3xl font-bold mt-1">{assets.length}</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs uppercase font-bold text-muted-foreground">Size in view</p>
            <p className="text-3xl font-bold mt-1">{formatBytes(totalBytes)}</p>
          </Card>
          <Card className={`p-5 ${missingCount ? "bg-rose-50 border-rose-200" : ""}`}>
            <p className="text-xs uppercase font-bold text-muted-foreground">Missing objects</p>
            <p className="text-3xl font-bold mt-1">{missingCount}</p>
          </Card>
        </div>
        <Card className="p-4 grid md:grid-cols-[1fr_220px_180px_auto] gap-3">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder="Search filename"
            />
          </div>
          <Select value={category} onValueChange={(value) => setCategory(value as typeof category)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="missing">Missing</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={!selected.length}
            onClick={() =>
              void downloadAdminFile(
                "/api/admin/sponsor-assets/backup.zip",
                "selected-sponsor-assets.zip",
                { method: "POST", body: JSON.stringify({ assetIds: selected }) },
              )
            }
          >
            <FileArchive className="h-4 w-4 mr-2" /> Download selected
          </Button>
        </Card>
        {error && (
          <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-rose-800">
            {error}
          </div>
        )}
        {backupBatches && (
          <Card className="p-5">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold">Complete offline backup</h3>
                <p className="text-sm text-muted-foreground">
                  Download each ZIP. Batches are kept below 500 MB where individual files allow.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setBackupBatches(null)}>
                Close
              </Button>
            </div>
            <div className="mt-4 grid md:grid-cols-2 gap-3">
              {backupBatches.map((batch, index) => (
                <div
                  key={index}
                  className="rounded-md border p-4 flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="font-medium">
                      Backup {index + 1} of {backupBatches.length}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {batch.assetIds.length} files · {formatBytes(batch.byteSize)} ·{" "}
                      {batch.sponsorIds.length} sponsors
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      void downloadAdminFile(
                        "/api/admin/sponsor-assets/backup.zip",
                        `swp-sponsor-backup-${index + 1}.zip`,
                        { method: "POST", body: JSON.stringify({ assetIds: batch.assetIds }) },
                      )
                    }
                  >
                    <Download className="h-4 w-4 mr-2" /> Download
                  </Button>
                </div>
              ))}
            </div>
            {backupBatches.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                There are no active files to back up.
              </p>
            )}
          </Card>
        )}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3 w-10"></th>
                  <th className="p-3 text-left">Sponsor</th>
                  <th className="p-3 text-left">Filename</th>
                  <th className="p-3 text-left">Category</th>
                  <th className="p-3 text-left">Version</th>
                  <th className="p-3 text-left">Size</th>
                  <th className="p-3 text-left">Uploaded</th>
                  <th className="p-3 text-left">Status</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td className="p-3">
                      <input
                        type="checkbox"
                        disabled={asset.status !== "active"}
                        checked={selected.includes(asset.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, asset.id]
                              : current.filter((id) => id !== asset.id),
                          )
                        }
                      />
                    </td>
                    <td className="p-3 font-medium">
                      {asset.sponsorCompany ?? `Sponsor #${asset.sponsorId}`}
                    </td>
                    <td className="p-3 max-w-[280px] truncate" title={asset.originalName}>
                      {asset.originalName}
                    </td>
                    <td className="p-3">{asset.category.replace("_", " ")}</td>
                    <td className="p-3">v{asset.version}</td>
                    <td className="p-3">{formatBytes(asset.byteSize)}</td>
                    <td className="p-3 whitespace-nowrap">
                      {new Date(asset.createdAt).toLocaleDateString("en-GB")}
                    </td>
                    <td className="p-3">
                      <Badge className={statusClass(asset.status)}>{asset.status}</Badge>
                    </td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void downloadAdminFile(
                            `/api/admin/sponsors/${asset.sponsorId}/assets/${asset.id}/download`,
                            asset.originalName,
                          )
                        }
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {!loading && !assets.length && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-muted-foreground">
                      No sponsor assets match these filters.
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-muted-foreground">
                      Loading asset library…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}
