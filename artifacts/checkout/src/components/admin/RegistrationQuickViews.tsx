export interface RegistrationQuickView {
  value: "needs_attention" | "incomplete" | "invoiced" | "paid" | "all";
  label: string;
  description: string;
  status: string;
  needsAttention: boolean;
}

const REGISTRATION_QUICK_VIEWS: RegistrationQuickView[] = [
  {
    value: "needs_attention",
    label: "Needs attention",
    description: "Failed delivery or sync",
    status: "all",
    needsAttention: true,
  },
  {
    value: "incomplete",
    label: "Incomplete",
    description: "Started, not finished",
    status: "partial",
    needsAttention: false,
  },
  {
    value: "invoiced",
    label: "Invoiced",
    description: "Awaiting payment",
    status: "invoiced",
    needsAttention: false,
  },
  {
    value: "paid",
    label: "Paid",
    description: "Confirmed bookings",
    status: "paid",
    needsAttention: false,
  },
  {
    value: "all",
    label: "All",
    description: "Every registration",
    status: "all",
    needsAttention: false,
  },
];

interface RegistrationQuickViewsProps {
  activeView: string;
  onSelect: (view: RegistrationQuickView) => void;
}

export function RegistrationQuickViews({ activeView, onSelect }: RegistrationQuickViewsProps) {
  return (
    <div className="bg-white border border-border shadow-sm mb-4 p-2">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {REGISTRATION_QUICK_VIEWS.map((view) => {
          const isActive = activeView === view.value;
          return (
            <button
              key={view.value}
              type="button"
              onClick={() => onSelect(view)}
              className={`text-left border px-4 py-3 transition-colors ${
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-white hover:bg-muted/50 text-foreground"
              }`}
            >
              <span className="block text-sm font-bold">{view.label}</span>
              <span
                className={`block text-xs mt-0.5 ${
                  isActive ? "text-primary/80" : "text-muted-foreground"
                }`}
              >
                {view.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
