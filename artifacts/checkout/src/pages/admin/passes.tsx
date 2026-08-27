import { useState, useEffect, useRef } from "react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Ticket,
  Infinity as InfinityIcon,
  AlertTriangle,
  Check,
  Plus,
  Trash2,
  GripVertical,
} from "lucide-react";

interface PassInventoryRow {
  passType: string;
  remaining: number | null;
}

interface PassConfig {
  passType: string;
  currentPrice: string;
  originalPrice: string;
  pricingPeriodName: string;
  benefits: string[];
  extraBenefits: string[];
}

const PASS_TYPES = [
  {
    passType: "single" as const,
    label: "Workforce Pass",
    description: "For employer-side attendees",
    showExtraBenefits: false,
  },
  {
    passType: "business" as const,
    label: "Business Pass",
    description: "For commercial attendees attending as delegates",
    showExtraBenefits: true,
  },
];

function adminFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem("admin_token") || "";
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...(init?.headers as Record<string, string>),
    },
  });
}

function BenefitsList({
  benefits,
  onChange,
  placeholder,
}: {
  benefits: string[];
  onChange: (list: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...benefits, trimmed]);
    setDraft("");
    inputRef.current?.focus();
  };

  const remove = (idx: number) => {
    onChange(benefits.filter((_, i) => i !== idx));
  };

  const handleDragStart = (idx: number) => {
    dragIdx.current = idx;
    setDragging(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOver(idx);
  };

  const handleDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === dropIdx) {
      setDragOver(null);
      setDragging(null);
      return;
    }
    const reordered = [...benefits];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(dropIdx, 0, moved);
    onChange(reordered);
    dragIdx.current = null;
    setDragging(null);
    setDragOver(null);
  };

  const handleDragEnd = () => {
    dragIdx.current = null;
    setDragging(null);
    setDragOver(null);
  };

  return (
    <div className="space-y-2">
      {benefits.map((b, idx) => (
        <div
          key={idx}
          draggable
          onDragStart={() => handleDragStart(idx)}
          onDragOver={(e) => handleDragOver(e, idx)}
          onDrop={(e) => handleDrop(e, idx)}
          onDragEnd={handleDragEnd}
          className={`flex items-center gap-2 group transition-opacity ${dragOver === idx && dragging !== idx ? "border-t-2 border-primary" : ""} ${dragging === idx ? "opacity-40" : ""}`}
        >
          <GripVertical className="w-4 h-4 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing" />
          <span className="flex-1 text-sm bg-white border border-border px-3 py-2">{b}</span>
          <button
            type="button"
            onClick={() => remove(idx)}
            className="p-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder || "Add a benefit…"}
          className="flex-1 h-9"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="h-9 px-3">
          <Plus className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

export default function AdminPasses() {
  const [activeTab, setActiveTab] = useState<"config" | "inventory">("config");

  const [inventory, setInventory] = useState<Record<string, number | null>>({
    single: null,
    business: null,
  });
  const [invInputs, setInvInputs] = useState<Record<string, string>>({
    single: "",
    business: "",
  });
  const [invLoading, setInvLoading] = useState(true);
  const [invSaving, setInvSaving] = useState<Record<string, boolean>>({});
  const [invSaved, setInvSaved] = useState<Record<string, boolean>>({});
  const [invErrors, setInvErrors] = useState<Record<string, string>>({});

  const [_configs, setConfigs] = useState<Record<string, PassConfig | null>>({
    single: null,
    business: null,
  });
  const [cfgDrafts, setCfgDrafts] = useState<Record<string, PassConfig>>({});
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState<Record<string, boolean>>({});
  const [cfgSaved, setCfgSaved] = useState<Record<string, boolean>>({});
  const [cfgErrors, setCfgErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setInvLoading(true);
    adminFetch("/api/admin/passes/inventory")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: PassInventoryRow[]) => {
        const inv: Record<string, number | null> = { single: null, business: null };
        const inp: Record<string, string> = { single: "", business: "" };
        for (const r of rows) {
          inv[r.passType] = r.remaining;
          inp[r.passType] = r.remaining !== null ? String(r.remaining) : "";
        }
        setInventory(inv);
        setInvInputs(inp);
      })
      .finally(() => setInvLoading(false));
  }, []);

  useEffect(() => {
    setCfgLoading(true);
    adminFetch("/api/admin/passes/config")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: Record<string, PassConfig | null>) => {
        setConfigs(data);
        const drafts: Record<string, PassConfig> = {};
        for (const pt of ["single", "business"]) {
          const c = data[pt];
          drafts[pt] = c ?? {
            passType: pt,
            currentPrice: pt === "business" ? "499" : "249",
            originalPrice: pt === "business" ? "999" : "429",
            pricingPeriodName: "Super Early Bird",
            benefits: [],
            extraBenefits: [],
          };
        }
        setCfgDrafts(drafts);
      })
      .finally(() => setCfgLoading(false));
  }, []);

  const handleInvSave = async (passType: string) => {
    setInvErrors((e) => ({ ...e, [passType]: "" }));
    const raw = invInputs[passType].trim();
    let val: number | null = null;
    if (raw !== "") {
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < 0) {
        setInvErrors((e) => ({
          ...e,
          [passType]: "Enter a positive number, or leave blank for unlimited",
        }));
        return;
      }
      val = n;
    }
    setInvSaving((s) => ({ ...s, [passType]: true }));
    try {
      const res = await adminFetch(`/api/admin/passes/inventory/${passType}`, {
        method: "PUT",
        body: JSON.stringify({ remaining: val }),
      });
      if (res.ok) {
        const row: PassInventoryRow = await res.json();
        setInventory((i) => ({ ...i, [passType]: row.remaining }));
        setInvSaved((s) => ({ ...s, [passType]: true }));
        setTimeout(() => setInvSaved((s) => ({ ...s, [passType]: false })), 2000);
      } else {
        const body = await res.json().catch(() => ({}));
        setInvErrors((e) => ({ ...e, [passType]: body.error || "Failed to save" }));
      }
    } finally {
      setInvSaving((s) => ({ ...s, [passType]: false }));
    }
  };

  const handleCfgSave = async (passType: string) => {
    setCfgErrors((e) => ({ ...e, [passType]: "" }));
    const draft = cfgDrafts[passType];
    if (!draft) return;

    const curPrice = parseFloat(draft.currentPrice);
    const origPrice = parseFloat(draft.originalPrice);
    if (isNaN(curPrice) || curPrice < 0) {
      setCfgErrors((e) => ({ ...e, [passType]: "Enter a valid current price" }));
      return;
    }
    if (isNaN(origPrice) || origPrice < 0) {
      setCfgErrors((e) => ({ ...e, [passType]: "Enter a valid original (full) price" }));
      return;
    }
    if (!draft.pricingPeriodName.trim()) {
      setCfgErrors((e) => ({ ...e, [passType]: "Pricing period name is required" }));
      return;
    }

    setCfgSaving((s) => ({ ...s, [passType]: true }));
    try {
      const res = await adminFetch(`/api/admin/passes/config/${passType}`, {
        method: "PUT",
        body: JSON.stringify({
          currentPrice: curPrice,
          originalPrice: origPrice,
          pricingPeriodName: draft.pricingPeriodName.trim(),
          benefits: draft.benefits,
          extraBenefits: draft.extraBenefits,
        }),
      });
      if (res.ok) {
        const row: PassConfig = await res.json();
        setConfigs((c) => ({ ...c, [passType]: row }));
        setCfgSaved((s) => ({ ...s, [passType]: true }));
        setTimeout(() => setCfgSaved((s) => ({ ...s, [passType]: false })), 2000);
      } else {
        const body = await res.json().catch(() => ({}));
        setCfgErrors((e) => ({ ...e, [passType]: body.error || "Failed to save" }));
      }
    } finally {
      setCfgSaving((s) => ({ ...s, [passType]: false }));
    }
  };

  const updateDraft = (
    passType: string,
    field: keyof PassConfig,
    value: PassConfig[keyof PassConfig],
  ) => {
    setCfgDrafts((d) => ({ ...d, [passType]: { ...d[passType], [field]: value } }));
  };

  const discountPct = (passType: string) => {
    const d = cfgDrafts[passType];
    if (!d) return null;
    const cur = parseFloat(d.currentPrice);
    const orig = parseFloat(d.originalPrice);
    if (!orig || !cur || orig <= cur) return null;
    return Math.round(((orig - cur) / orig) * 100);
  };

  return (
    <AdminLayout title="Tickets">
      <div className="max-w-3xl">
        <div className="flex gap-0 mb-8 border-b border-border">
          <button
            onClick={() => setActiveTab("config")}
            className={`px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === "config"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Ticket Configuration
          </button>
          <button
            onClick={() => setActiveTab("inventory")}
            className={`px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === "inventory"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Availability
          </button>
        </div>

        {activeTab === "config" && (
          <div className="space-y-6">
            <p className="text-muted-foreground text-sm">
              Configure pricing, the current pricing period name, and what's included in each pass.
              Changes appear immediately on the checkout page.
            </p>

            {cfgLoading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : (
              PASS_TYPES.map(({ passType, label, description, showExtraBenefits }) => {
                const draft = cfgDrafts[passType];
                if (!draft) return null;
                const pct = discountPct(passType);
                return (
                  <div key={passType} className="bg-white border border-border">
                    <div className="px-6 py-4 border-b border-border flex items-start gap-3">
                      <div className="w-9 h-9 rounded-sm bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <Ticket className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-bold text-base">{label}</h3>
                        <p className="text-sm text-muted-foreground">{description}</p>
                      </div>
                    </div>

                    <div className="p-6 space-y-6">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            Sale Price (£, ex VAT)
                          </label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={draft.currentPrice}
                            onChange={(e) => updateDraft(passType, "currentPrice", e.target.value)}
                            className="h-10"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            The price buyers pay now
                          </p>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            Full Price (£, ex VAT)
                          </label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={draft.originalPrice}
                            onChange={(e) => updateDraft(passType, "originalPrice", e.target.value)}
                            className="h-10"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Shown as strikethrough
                          </p>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            Pricing Period
                          </label>
                          <Input
                            type="text"
                            placeholder="e.g. Super Early Bird"
                            value={draft.pricingPeriodName}
                            onChange={(e) =>
                              updateDraft(passType, "pricingPeriodName", e.target.value)
                            }
                            className="h-10"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Shown below the price
                          </p>
                        </div>
                      </div>

                      {pct !== null && (
                        <div className="bg-green-50 border border-green-200 rounded-sm px-4 py-2.5 text-sm text-green-800 font-medium">
                          Discount badge will show: <strong>{pct}% off</strong> (£
                          {parseFloat(draft.currentPrice).toFixed(0)} vs £
                          {parseFloat(draft.originalPrice).toFixed(0)})
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                          What's Included
                        </label>
                        <BenefitsList
                          benefits={draft.benefits}
                          onChange={(list) => updateDraft(passType, "benefits", list)}
                          placeholder="Add an included benefit…"
                        />
                      </div>

                      {showExtraBenefits && (
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            Business Pass guidance
                          </label>
                          <p className="text-xs text-muted-foreground mb-3">
                            These guidance points are shown separately below the standard benefits.
                          </p>
                          <BenefitsList
                            benefits={draft.extraBenefits}
                            onChange={(list) => updateDraft(passType, "extraBenefits", list)}
                            placeholder="Add Business Pass guidance…"
                          />
                        </div>
                      )}

                      {cfgErrors[passType] && (
                        <p className="text-sm text-destructive">{cfgErrors[passType]}</p>
                      )}

                      <div className="flex justify-end">
                        <Button
                          onClick={() => handleCfgSave(passType)}
                          disabled={cfgSaving[passType]}
                          className={`h-10 px-6 ${cfgSaved[passType] ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                        >
                          {cfgSaved[passType] ? (
                            <span className="flex items-center gap-1.5">
                              <Check className="w-4 h-4" /> Saved
                            </span>
                          ) : cfgSaving[passType] ? (
                            "Saving…"
                          ) : (
                            "Save Changes"
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === "inventory" && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Set the number of remaining passes for each pass type. When a count is configured, it
              will be displayed on the checkout as urgency messaging to encourage bookings. Leave
              blank for unlimited.
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-sm p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">
                These counts are informational only — the checkout does not enforce them or prevent
                over-booking. They are purely for displaying urgency messaging to prospective
                attendees.
              </p>
            </div>

            {invLoading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : (
              <div className="space-y-4">
                {PASS_TYPES.map(({ passType, label, description }) => {
                  const current = inventory[passType];
                  return (
                    <div key={passType} className="bg-white border border-border p-6">
                      <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-sm bg-primary/10 flex items-center justify-center shrink-0">
                          <Ticket className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-base mb-0.5">{label}</h3>
                          <p className="text-sm text-muted-foreground mb-4">{description}</p>

                          <div className="flex items-start gap-3 flex-wrap">
                            <div className="w-44">
                              <Input
                                type="number"
                                min="0"
                                placeholder="Unlimited"
                                value={invInputs[passType]}
                                onChange={(e) =>
                                  setInvInputs((i) => ({ ...i, [passType]: e.target.value }))
                                }
                                onKeyDown={(e) => e.key === "Enter" && handleInvSave(passType)}
                                className="h-10"
                              />
                            </div>
                            <Button
                              onClick={() => handleInvSave(passType)}
                              disabled={invSaving[passType]}
                              className={`h-10 ${invSaved[passType] ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                            >
                              {invSaved[passType] ? (
                                <span className="flex items-center gap-1.5">
                                  <Check className="w-4 h-4" /> Saved
                                </span>
                              ) : invSaving[passType] ? (
                                "Saving…"
                              ) : (
                                "Save"
                              )}
                            </Button>
                            {invInputs[passType] !== "" && (
                              <Button
                                variant="outline"
                                className="h-10"
                                onClick={() => setInvInputs((i) => ({ ...i, [passType]: "" }))}
                              >
                                Set Unlimited
                              </Button>
                            )}
                          </div>

                          {invErrors[passType] && (
                            <p className="text-sm text-destructive mt-2">{invErrors[passType]}</p>
                          )}

                          <div className="mt-4 flex items-center gap-2 text-sm">
                            {current === null ? (
                              <>
                                <InfinityIcon className="w-4 h-4 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  Currently showing as <strong>unlimited</strong> on checkout
                                </span>
                              </>
                            ) : current <= 10 ? (
                              <>
                                <span className="inline-block w-2 h-2 rounded-full bg-red-500 shrink-0" />
                                <span className="text-red-700 font-semibold">
                                  Only {current} left — high urgency shown on checkout
                                </span>
                              </>
                            ) : current <= 30 ? (
                              <>
                                <span className="inline-block w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                                <span className="text-amber-700 font-semibold">
                                  {current} remaining — urgency shown on checkout
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
                                <span className="text-muted-foreground">
                                  {current} remaining shown on checkout
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
