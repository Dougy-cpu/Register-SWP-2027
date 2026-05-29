import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useListPromoCodes,
  useCreatePromoCode,
  useUpdatePromoCode,
  useDeletePromoCode,
  type PromoCode,
  type CreatePromoCodeBody,
  type CreatePromoCodeBodyApplicablePassTypesItem,
} from "@workspace/api-client-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2, Plus, Pencil, Link2, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

function CopyLinkButton({ code }: { code: string }) {
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
  const url = `${base}/?promo=${encodeURIComponent(code)}`;
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={handleCopy} aria-label="Copy auto-apply link">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Link2 className="w-4 h-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all font-mono text-xs">{url}</TooltipContent>
    </Tooltip>
  );
}

const promoSchema = z
  .object({
    code: z.string().min(1, "Code is required").toUpperCase(),
    discountType: z.enum(["percentage", "fixed", "per_ticket", "complimentary"]),
    discountValue: z.coerce.number().min(0, "Value must be 0 or greater"),
    maxUses: z.coerce.number().int().positive().optional().nullable(),
    isActive: z.boolean().default(true),
    applySingle: z.boolean().default(true),
    applyBusiness: z.boolean().default(true),
    oncePerCustomer: z.boolean().default(false),
    minQuantity: z.coerce.number().int().positive().optional().nullable(),
    maxDiscountAmount: z.coerce.number().positive().optional().nullable(),
    internalNote: z.string().optional().nullable(),
  })
  .refine((data) => data.applySingle || data.applyBusiness, {
    message: "At least one pass type must be selected",
    path: ["applySingle"],
  })
  .refine((data) => data.discountType === "complimentary" || data.discountValue > 0, {
    message: "Value must be greater than 0 for this discount type",
    path: ["discountValue"],
  });

type PromoFormValues = z.infer<typeof promoSchema>;

function passTypeBadges(types: string[] | undefined) {
  if (!types || types.length === 0) {
    return <Badge variant="secondary">Both</Badge>;
  }
  if (types.includes("single") && types.includes("business")) {
    return <Badge variant="secondary">Both</Badge>;
  }
  return (
    <div className="flex gap-1 flex-wrap">
      {types.includes("single") && (
        <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Single</Badge>
      )}
      {types.includes("business") && (
        <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100">Business</Badge>
      )}
    </div>
  );
}

function restrictionBadges(promo: PromoCode) {
  const items: { key: string; label: string }[] = [];
  if (promo.oncePerCustomer) items.push({ key: "once", label: "1/customer" });
  if (promo.minQuantity) items.push({ key: "min", label: `min ${promo.minQuantity}` });
  if (promo.discountType === "percentage" && promo.maxDiscountAmount) {
    items.push({ key: "cap", label: `cap \u00a3${promo.maxDiscountAmount}` });
  }
  if (items.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap mt-1">
      {items.map((b) => (
        <Badge key={b.key} variant="outline" className="text-[10px] font-normal py-0 px-1.5 h-5">
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

interface PromoFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: PromoCode | null;
  onSubmit: (values: PromoFormValues) => Promise<void>;
  submitting: boolean;
  trigger?: React.ReactNode;
}

function PromoFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  submitting,
  trigger,
}: PromoFormDialogProps) {
  const isEdit = !!initial;
  const form = useForm<PromoFormValues>({
    resolver: zodResolver(promoSchema),
    values: {
      code: initial?.code ?? "",
      discountType: (initial?.discountType as PromoFormValues["discountType"]) ?? "percentage",
      discountValue: initial ? Number(initial.discountValue) : 10,
      maxUses: initial?.maxUses ?? null,
      isActive: initial?.isActive ?? true,
      applySingle: initial ? (initial.applicablePassTypes ?? []).includes("single") : true,
      applyBusiness: initial ? (initial.applicablePassTypes ?? []).includes("business") : true,
      oncePerCustomer: initial?.oncePerCustomer ?? false,
      minQuantity: initial?.minQuantity ?? null,
      maxDiscountAmount: initial?.maxDiscountAmount ?? null,
      internalNote: initial?.internalNote ?? "",
    },
  });

  const { watch } = form;
  const applySingle = watch("applySingle");
  const applyBusiness = watch("applyBusiness");
  const discountType = watch("discountType");

  const handleSubmit = async (values: PromoFormValues) => {
    await onSubmit(values);
    if (!isEdit) form.reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Promo Code" : "Create New Promo Code"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. EARLYBIRD20" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="discountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage (%)</SelectItem>
                        <SelectItem value="fixed">Fixed Amount (GBP)</SelectItem>
                        <SelectItem value="per_ticket">Per Ticket (GBP per ticket)</SelectItem>
                        <SelectItem value="complimentary">Complimentary (free ticket)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="discountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Value</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="maxUses"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Uses (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value === "" ? null : e.target.value)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="minQuantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum Quantity (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="e.g. 3"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value === "" ? null : e.target.value)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="maxDiscountAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Discount Cap (GBP, percentage codes only)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 200"
                      disabled={discountType !== "percentage"}
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? null : e.target.value)
                      }
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Caps the GBP saving from a percentage code. Leave blank for no cap.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="border rounded-md p-4 space-y-3">
              <p className="text-sm font-medium leading-none">Applies To</p>
              <p className="text-xs text-muted-foreground">
                Select which pass types this code can be used with.
              </p>
              <FormField
                control={form.control}
                name="applySingle"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div>
                      <FormLabel className="font-normal">HR Professional Pass</FormLabel>
                      <p className="text-xs text-muted-foreground">HR professional ticket</p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={!applyBusiness && field.value}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="applyBusiness"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div>
                      <FormLabel className="font-normal">Business Pass</FormLabel>
                      <p className="text-xs text-muted-foreground">Vendor / supplier ticket</p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={!applySingle && field.value}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {form.formState.errors.applySingle && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.applySingle.message}
                </p>
              )}
            </div>

            <FormField
              control={form.control}
              name="oncePerCustomer"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between p-4 border rounded-md">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">One use per customer (email)</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      Each lead email may redeem this code only once across confirmed bookings.
                    </p>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="internalNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Internal note (admin only)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g. Q3 LinkedIn campaign"
                      rows={2}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between p-4 border rounded-md">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active Status</FormLabel>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex justify-end pt-4">
              <Button type="submit" disabled={submitting}>
                {isEdit ? "Save Changes" : "Save Promo Code"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminPromoCodes() {
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<PromoCode | null>(null);

  const { data, isLoading } = useListPromoCodes({
    query: {
      queryKey: ["promoCodes"],
    },
  });

  const createPromo = useCreatePromoCode();
  const updatePromo = useUpdatePromoCode();
  const deletePromo = useDeletePromoCode();

  const buildPayload = (values: PromoFormValues): CreatePromoCodeBody => {
    const applicablePassTypes: CreatePromoCodeBodyApplicablePassTypesItem[] = [];
    if (values.applySingle) applicablePassTypes.push("single");
    if (values.applyBusiness) applicablePassTypes.push("business");
    return {
      code: values.code,
      discountType: values.discountType,
      discountValue: values.discountValue,
      maxUses: values.maxUses ?? null,
      isActive: values.isActive,
      applicablePassTypes,
      oncePerCustomer: values.oncePerCustomer,
      minQuantity: values.minQuantity ?? null,
      maxDiscountAmount:
        values.discountType === "percentage" ? (values.maxDiscountAmount ?? null) : null,
      internalNote: values.internalNote?.trim() ? values.internalNote.trim() : null,
    };
  };

  const onCreate = async (values: PromoFormValues) => {
    await createPromo.mutateAsync({ data: buildPayload(values) });
    queryClient.invalidateQueries({ queryKey: ["promoCodes"] });
    setIsAddOpen(false);
  };

  const onEdit = async (values: PromoFormValues) => {
    if (!editing) return;
    await updatePromo.mutateAsync({ id: editing.id, data: buildPayload(values) });
    queryClient.invalidateQueries({ queryKey: ["promoCodes"] });
    setEditing(null);
  };

  const toggleActive = async (id: number, isActive: boolean) => {
    await updatePromo.mutateAsync({ id, data: { isActive } });
    queryClient.invalidateQueries({ queryKey: ["promoCodes"] });
  };

  const handleDelete = async (id: number) => {
    if (confirm("Are you sure you want to delete this promo code?")) {
      await deletePromo.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: ["promoCodes"] });
    }
  };

  return (
    <AdminLayout title="Promo Codes">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground">Manage discount codes and special offers.</p>

        <PromoFormDialog
          open={isAddOpen}
          onOpenChange={setIsAddOpen}
          onSubmit={onCreate}
          submitting={createPromo.isPending}
          trigger={
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Promo Code
              </Button>
            </DialogTrigger>
          }
        />

        {editing && (
          <PromoFormDialog
            open={!!editing}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            initial={editing}
            onSubmit={onEdit}
            submitting={updatePromo.isPending}
          />
        )}
      </div>

      <div className="bg-white border border-border shadow-sm">
        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Applies To</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Link</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.map((promo) => (
                  <TableRow key={promo.id}>
                    <TableCell>
                      <div className="font-mono font-bold text-lg">{promo.code}</div>
                      {restrictionBadges(promo)}
                    </TableCell>
                    <TableCell>
                      {promo.discountType === "percentage" ? (
                        `${promo.discountValue}%`
                      ) : promo.discountType === "per_ticket" ? (
                        `\u00a3${promo.discountValue}/ticket`
                      ) : promo.discountType === "complimentary" ? (
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          Free ticket
                        </Badge>
                      ) : (
                        `\u00a3${promo.discountValue}`
                      )}
                    </TableCell>
                    <TableCell>{passTypeBadges(promo.applicablePassTypes)}</TableCell>
                    <TableCell className="max-w-[200px]">
                      {promo.internalNote ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate text-xs text-muted-foreground cursor-help">
                              {promo.internalNote}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs whitespace-pre-wrap">
                            {promo.internalNote}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {promo.discountType === "complimentary"
                        ? promo.maxUses
                          ? `${promo.usedCount} / ${promo.maxUses} tickets`
                          : `${promo.usedCount} tickets`
                        : `${promo.usedCount} ${promo.maxUses ? `/ ${promo.maxUses}` : "used"}`}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={promo.isActive}
                        onCheckedChange={(val) => toggleActive(promo.id, val)}
                      />
                    </TableCell>
                    <TableCell>
                      <CopyLinkButton code={promo.code} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(promo)}
                        aria-label="Edit promo code"
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(promo.id)}
                        className="text-destructive hover:bg-destructive/10"
                        aria-label="Delete promo code"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      No promo codes created yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TooltipProvider>
        )}
      </div>
    </AdminLayout>
  );
}
