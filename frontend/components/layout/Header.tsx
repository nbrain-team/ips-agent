"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageSquare, Database, Lightbulb, UserCircle, Users, Activity, LogOut, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

const NAV = [
  { href: "/ai-chat", label: "Chat", icon: MessageSquare },
  { href: "/tips", label: "Tips", icon: Lightbulb },
  { href: "/data", label: "Data", icon: Database },
  { href: "/account", label: "Account", icon: UserCircle },
];

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user || null))
      .catch(() => {});
    try {
      const saved = localStorage.getItem("ips-theme") === "dark";
      setDark(saved);
      document.documentElement.classList.toggle("dark", saved);
    } catch {
      /* ignore */
    }
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("ips-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    router.push("/login");
  }

  return (
    <header className="h-14 bg-ips-charcoal border-b-4 border-ips-red flex items-center px-4 gap-6 shrink-0">
      <Link href="/ai-chat" className="flex items-center gap-3">
        <Image src="/ips-logo.png" alt="IPS, Inc." width={72} height={45} className="h-9 w-auto" priority />
        <span className="text-white font-semibold text-sm hidden sm:block tracking-wide">
          AI Brain
        </span>
      </Link>
      <nav className="flex items-center gap-1 ml-4">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors",
              pathname.startsWith(href)
                ? "bg-ips-red text-white"
                : "text-gray-300 hover:text-white hover:bg-white/10"
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden md:inline">{label}</span>
          </Link>
        ))}
        {user?.role === "admin" && (
          <>
            <Link
              href="/admin/users"
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors",
                pathname.startsWith("/admin/users")
                  ? "bg-ips-red text-white"
                  : "text-gray-300 hover:text-white hover:bg-white/10"
              )}
            >
              <Users className="h-4 w-4" />
              <span className="hidden md:inline">Users</span>
            </Link>
            <Link
              href="/admin/ops"
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors",
                pathname.startsWith("/admin/ops")
                  ? "bg-ips-red text-white"
                  : "text-gray-300 hover:text-white hover:bg-white/10"
              )}
            >
              <Activity className="h-4 w-4" />
              <span className="hidden md:inline">Ops</span>
            </Link>
          </>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {user && <span className="text-gray-400 text-xs hidden sm:block">{user.email}</span>}
        <button
          onClick={toggleTheme}
          className="text-gray-300 hover:text-white p-1.5 rounded hover:bg-white/10"
          title={dark ? "Light mode" : "Dark mode"}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button
          onClick={logout}
          className="text-gray-300 hover:text-white p-1.5 rounded hover:bg-white/10"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
