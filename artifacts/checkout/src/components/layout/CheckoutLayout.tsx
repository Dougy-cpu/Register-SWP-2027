import { ReactNode } from "react";
import logoUrl from "@assets/swp-summit-logo.png";
import CheckoutProgress from "@/components/checkout/CheckoutProgress";

interface CheckoutLayoutProps {
  children: ReactNode;
  currentStep?: number;
}

export default function CheckoutLayout({ children, currentStep = 1 }: CheckoutLayoutProps) {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/20 selection:text-primary swp-grid-bg">
      <header className="sticky top-0 z-20 w-full border-b border-primary/10 bg-white/95 shadow-[0_8px_30px_rgba(0,78,185,0.04)] backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:h-20 md:px-6">
          <img src={logoUrl} alt="SWP Summit" className="h-10 w-auto object-contain md:h-12" />
          <p className="hidden text-sm font-medium text-muted-foreground md:block">
            Wednesday, 3 March 2027 · London
          </p>
        </div>
        <CheckoutProgress currentStep={currentStep} />
      </header>

      <main className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-8 md:px-6 md:py-12">
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
