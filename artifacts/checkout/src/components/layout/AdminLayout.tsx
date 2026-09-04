import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import logoUrl from "@assets/swp-summit-logo.png";
import {
  LayoutDashboard,
  Users,
  Tag,
  Percent,
  Mail,
  Bell,
  Ticket,
  Settings,
  LogOut,
  Activity,
  Handshake,
  FolderArchive,
  ScanLine,
} from "lucide-react";

interface AdminLayoutProps {
  children: ReactNode;
  title: string;
}

export default function AdminLayout({ children, title }: AdminLayoutProps) {
  const [, setLocation] = useLocation();

  useEffect(() => {
    const token = localStorage.getItem("admin_token");
    if (!token) {
      setLocation("/admin/login");
      return;
    }

    const handleUnauthorized = () => {
      localStorage.removeItem("admin_token");
      setLocation("/admin/login");
    };

    window.addEventListener("api:unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("api:unauthorized", handleUnauthorized);
    };
  }, [setLocation]);

  const navItems = [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
    { href: "/admin/registrations", label: "Registrations", icon: Users },
    { href: "/admin/sponsors", label: "Sponsors", icon: Handshake },
    { href: "/admin/lead-scanner", label: "Lead Scanner", icon: ScanLine },
    { href: "/admin/sponsor-assets", label: "Sponsor Assets", icon: FolderArchive },
    { href: "/admin/promo-codes", label: "Promo Codes", icon: Tag },
    { href: "/admin/discount-tiers", label: "Discounts", icon: Percent },
    { href: "/admin/emails", label: "Emails", icon: Mail },
    { href: "/admin/activity", label: "Activity", icon: Activity },
    { href: "/admin/notifications", label: "Notifications", icon: Bell },
    { href: "/admin/passes", label: "Tickets", icon: Ticket },
    { href: "/admin/settings", label: "Settings", icon: Settings },
  ];

  const handleLogout = () => {
    localStorage.removeItem("admin_token");
    setLocation("/admin/login");
  };

  return (
    <div className="min-h-screen flex bg-muted/30">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-950 text-white flex flex-col fixed h-full z-20">
        <div className="h-20 flex items-center px-6 border-b border-white/10 bg-black">
          <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto bg-white" />
        </div>
        <nav className="flex-1 py-6 px-4 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-md hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
          >
            <LogOut className="w-5 h-5" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 ml-64 flex flex-col min-h-screen">
        <header className="h-20 bg-white border-b border-border flex items-center px-8 sticky top-0 z-10">
          <h1 className="text-2xl font-bold">{title}</h1>
        </header>
        <div className="p-8 flex-1">{children}</div>
      </main>
    </div>
  );
}
