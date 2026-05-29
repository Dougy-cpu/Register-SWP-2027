import { useState } from "react";
import { useListDiscountTiers, useUpdateDiscountTiers } from "@workspace/api-client-react";

type TierDraft = {
  id?: number;
  minQuantity: number | string;
  discountPercent: number | string;
  label?: string | null;
};
import AdminLayout from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trash2, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminDiscountTiers() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("single");

  const { data: tiers, isLoading } = useListDiscountTiers({
    query: {
      queryKey: ["discountTiers"],
    },
  });

  const updateTiers = useUpdateDiscountTiers();

  const [localTiers, setLocalTiers] = useState<Record<string, TierDraft[]>>({});

  // Sync server data to local state when it arrives
  if (tiers && Object.keys(localTiers).length === 0) {
    const grouped = {
      single: tiers.filter((t) => t.passType === "single"),
      business: tiers.filter((t) => t.passType === "business"),
    };
    setLocalTiers(grouped);
  }

  const handleSave = async (passType: string) => {
    const passTiers = localTiers[passType] || [];
    await updateTiers.mutateAsync({
      data: {
        passType: passType as "single" | "business",
        tiers: passTiers.map((t) => ({
          minQuantity: Number(t.minQuantity),
          discountPercent: Number(t.discountPercent),
          label: t.label || null,
        })),
      },
    });
    queryClient.invalidateQueries({ queryKey: ["discountTiers"] });
  };

  const addTier = (passType: string) => {
    const current = localTiers[passType] || [];
    setLocalTiers({
      ...localTiers,
      [passType]: [...current, { minQuantity: 2, discountPercent: 10, label: "" }],
    });
  };

  const removeTier = (passType: string, index: number) => {
    const current = localTiers[passType] || [];
    setLocalTiers({
      ...localTiers,
      [passType]: current.filter((_, i) => i !== index),
    });
  };

  const updateTier = (passType: string, index: number, field: keyof TierDraft, value: string) => {
    const current = [...(localTiers[passType] || [])];
    current[index] = { ...current[index], [field]: value };
    setLocalTiers({
      ...localTiers,
      [passType]: current,
    });
  };

  if (isLoading) {
    return (
      <AdminLayout title="Volume Discounts">
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AdminLayout>
    );
  }

  const renderTabContent = (passType: string) => {
    const passTiers = localTiers[passType] || [];

    return (
      <div className="bg-white p-6 border border-border shadow-sm mt-6">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-bold capitalize">{passType} Pass Tiers</h3>
          <Button variant="outline" size="sm" onClick={() => addTier(passType)} className="gap-2">
            <Plus className="w-4 h-4" /> Add Tier
          </Button>
        </div>

        {passTiers.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">No discount tiers configured.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-12 gap-4 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-border">
              <div className="col-span-3">Min Quantity</div>
              <div className="col-span-3">Discount %</div>
              <div className="col-span-5">Label (Optional)</div>
              <div className="col-span-1 text-right"></div>
            </div>

            {passTiers.map((tier, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-3">
                  <Input
                    type="number"
                    value={tier.minQuantity}
                    onChange={(e) => updateTier(passType, idx, "minQuantity", e.target.value)}
                  />
                </div>
                <div className="col-span-3">
                  <Input
                    type="number"
                    value={tier.discountPercent}
                    onChange={(e) => updateTier(passType, idx, "discountPercent", e.target.value)}
                  />
                </div>
                <div className="col-span-5">
                  <Input
                    value={tier.label || ""}
                    placeholder="e.g. Group Discount"
                    onChange={(e) => updateTier(passType, idx, "label", e.target.value)}
                  />
                </div>
                <div className="col-span-1 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeTier(passType, idx)}
                    className="text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-border flex justify-end">
          <Button onClick={() => handleSave(passType)} disabled={updateTiers.isPending}>
            {updateTiers.isPending ? "Saving..." : "Save Tiers"}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <AdminLayout title="Volume Discounts">
      <p className="text-muted-foreground mb-8">
        Configure automatic group discounts applied based on the number of attendees.
      </p>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-white border border-border h-12 w-full justify-start rounded-none">
          <TabsTrigger
            value="single"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-8 rounded-none"
          >
            Single Pass
          </TabsTrigger>
          <TabsTrigger
            value="business"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-8 rounded-none"
          >
            Business Pass
          </TabsTrigger>
        </TabsList>
        <TabsContent value="single">{renderTabContent("single")}</TabsContent>
        <TabsContent value="business">{renderTabContent("business")}</TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
