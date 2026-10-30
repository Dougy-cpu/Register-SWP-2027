import { ReactNode } from "react";
import logoUrl from "@assets/swp-summit-logo.png";
import pshLogoUrl from "@assets/people-strategy-hub.png";
import CheckoutProgress from "@/components/checkout/CheckoutProgress";

interface CheckoutLayoutProps {
  children: ReactNode;
  currentStep?: number;
}

export default function CheckoutLayout({ children, currentStep = 1 }: CheckoutLayoutProps) {
  return (
    <div className="checkout-shell min-h-[100dvh] flex flex-col bg-white selection:bg-primary/20 selection:text-primary">
      <header className="w-full border-b border-border bg-white">
        <div className="mx-auto flex max-w-[1408px] items-center justify-between gap-4 px-5 py-5 md:px-8 md:py-4">
          <div className="flex min-w-0 items-center gap-3 md:gap-6">
            <img
              src={logoUrl}
              alt="SWP Summit"
              className="h-12 w-12 shrink-0 object-contain md:h-20 md:w-20"
            />
            <div>
              <p className="text-lg font-bold tracking-tight md:text-[28px]">SWP Summit 2027</p>
              <p className="mt-1 text-xs text-muted-foreground md:text-sm">
                Wednesday, 3 March 2027
                <span className="hidden sm:inline"> · 1 Basinghall Avenue, London</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm text-muted-foreground md:block">An event by</span>
            <img
              src={pshLogoUrl}
              alt="People Strategy Hub"
              className="h-12 w-12 object-contain md:h-20 md:w-20"
            />
          </div>
        </div>
        <CheckoutProgress currentStep={currentStep} />
      </header>

      <main className="relative mx-auto flex w-full max-w-[1408px] flex-1 flex-col px-5 py-8 md:px-8 md:py-8">
        {children}
      </main>

      <footer className="relative w-full border-t border-border mt-auto py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-muted-foreground font-medium">
          SWP Summit 2027 - Wednesday, 3 March 2027 - 1 Basinghall Avenue, London
        </div>
      </footer>
    </div>
  );
}
