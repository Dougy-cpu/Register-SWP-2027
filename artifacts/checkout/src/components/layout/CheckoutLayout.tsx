import { ReactNode } from "react";
import logoUrl from "@assets/logo.webp";

interface CheckoutLayoutProps {
  children: ReactNode;
  currentStep?: number;
}

export default function CheckoutLayout({ children, currentStep = 1 }: CheckoutLayoutProps) {
  const steps = ["Your Details", "Select Passes", "Attendee Details", "Payment"];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/20 selection:text-primary">
      <header className="w-full border-b border-border bg-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <img src={logoUrl} alt="HR Analytics Summit" className="h-8 object-contain" />
          {currentStep < 5 && (
            <div className="text-sm font-medium text-muted-foreground hidden md:block">
              Step {currentStep} of 4:{" "}
              <span className="text-foreground">{steps[currentStep - 1]}</span>
            </div>
          )}
        </div>

        {/* Progress Bar */}
        {currentStep < 5 && (
          <div className="w-full bg-muted h-1">
            <div
              className="bg-primary h-full transition-all duration-500 ease-out"
              style={{ width: `${(currentStep / 4) * 100}%` }}
            />
          </div>
        )}
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-12 flex flex-col">{children}</main>

      <footer className="w-full border-t border-border mt-auto py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-muted-foreground font-medium">
          HR Analytics Summit — 3 September 2026 — 155 Bishopsgate, London
        </div>
      </footer>
    </div>
  );
}
