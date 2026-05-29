import { useState } from "react";
import { useLocation } from "wouter";
import { useAdminLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import logoUrl from "@assets/logo.webp";

export default function AdminLogin() {
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const loginMutation = useAdminLogin();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await loginMutation.mutateAsync({
        data: { password },
      });
      localStorage.setItem("admin_token", res.token);
      setLocation("/admin");
    } catch (_err) {
      setError("Invalid password");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
      <div className="w-full max-w-md bg-white p-8 border border-border shadow-xl">
        <div className="flex justify-center mb-8">
          <img src={logoUrl} alt="Logo" className="h-10" />
        </div>
        <h1 className="text-2xl font-bold text-center mb-6">Admin Panel</h1>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-bold uppercase tracking-wider">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 bg-white"
            />
          </div>

          {error && <p className="text-sm text-destructive font-medium">{error}</p>}

          <Button type="submit" className="w-full h-12 text-lg" disabled={loginMutation.isPending}>
            {loginMutation.isPending ? "Authenticating..." : "Login"}
          </Button>
        </form>
      </div>
    </div>
  );
}
