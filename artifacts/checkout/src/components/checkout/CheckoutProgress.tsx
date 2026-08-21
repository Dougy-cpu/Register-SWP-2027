import { Check } from "lucide-react";

const STEPS = ["Your details", "Passes", "Attendees", "Payment"];

export default function CheckoutProgress({ currentStep }: { currentStep: number }) {
  if (currentStep >= 5) return null;

  return (
    <nav aria-label="Checkout progress" className="border-t border-primary/10 bg-white/95">
      <div className="mx-auto max-w-4xl px-5 py-3 md:px-6 md:py-4">
        <div className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground md:hidden">
          <span>
            Step {currentStep} of {STEPS.length}
          </span>
          <span className="text-primary">{STEPS[currentStep - 1]}</span>
        </div>

        <ol className="relative grid grid-cols-4 gap-2">
          <li
            aria-hidden="true"
            className="absolute left-[12.5%] right-[12.5%] top-4 h-px bg-primary/15"
          />
          {STEPS.map((label, index) => {
            const step = index + 1;
            const isCurrent = step === currentStep;
            const isComplete = step < currentStep;

            return (
              <li
                key={label}
                aria-current={isCurrent ? "step" : undefined}
                className="relative flex min-w-0 flex-col items-center gap-2 text-center"
              >
                <span
                  className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold transition-colors ${
                    isComplete
                      ? "border-primary bg-primary text-white"
                      : isCurrent
                        ? "border-primary bg-white text-primary ring-4 ring-primary/10"
                        : "border-primary/20 bg-white text-muted-foreground"
                  }`}
                >
                  {isComplete ? <Check className="h-4 w-4" /> : step}
                </span>
                <span
                  className={`truncate text-[11px] font-semibold sm:text-xs ${
                    isCurrent ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
