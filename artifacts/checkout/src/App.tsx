import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import CheckoutFlow from "@/pages/checkout";
import AdminDashboard from "@/pages/admin/dashboard";
import AdminLogin from "@/pages/admin/login";
import AdminRegistrations from "@/pages/admin/registrations";
import AdminPromoCodes from "@/pages/admin/promo-codes";
import AdminDiscountTiers from "@/pages/admin/discount-tiers";
import AdminEmails from "@/pages/admin/emails";
import AdminNotifications from "@/pages/admin/notifications";
import AdminPasses from "@/pages/admin/passes";
import AdminSettings from "@/pages/admin/settings";
import AdminActivity from "@/pages/admin/activity";
import ManageAttendees from "@/pages/manage/ManageAttendees";
import EditBilling from "@/pages/manage/EditBilling";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={CheckoutFlow} />
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/registrations" component={AdminRegistrations} />
      <Route path="/admin/promo-codes" component={AdminPromoCodes} />
      <Route path="/admin/discount-tiers" component={AdminDiscountTiers} />
      <Route path="/admin/emails" component={AdminEmails} />
      <Route path="/admin/notifications" component={AdminNotifications} />
      <Route path="/admin/passes" component={AdminPasses} />
      <Route path="/admin/settings" component={AdminSettings} />
      <Route path="/admin/activity" component={AdminActivity} />
      <Route path="/manage/:token/billing" component={EditBilling} />
      <Route path="/manage/:token" component={ManageAttendees} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
