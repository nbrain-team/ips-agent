"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

function AccountContent() {
  const params = useSearchParams();
  const [user, setUser] = useState<any>(null);
  const [current, setCurrent] = useState("");
  const [next1, setNext1] = useState("");
  const [next2, setNext2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const mustChange = params.get("change_password") === "1";

  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user || null));
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next1 !== next2) return setMsg({ ok: false, text: "New passwords don't match" });
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next1 }),
    });
    const data = await res.json();
    if (!res.ok) return setMsg({ ok: false, text: data.error || "Failed" });
    setMsg({ ok: true, text: "Password updated" });
    setCurrent(""); setNext1(""); setNext2("");
  }

  return (
    <main className="flex-1 max-w-2xl w-full mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-ips-charcoal">Account</h1>
      {mustChange && (
        <div className="border border-amber-300 bg-amber-50 text-amber-800 rounded-lg px-3 py-2 text-sm">
          Please set a new password before continuing.
        </div>
      )}
      <Card>
        <CardHeader><CardTitle className="text-sm">Profile</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><span className="text-ips-charcoal-600">Email:</span> {user?.email}</p>
          <p><span className="text-ips-charcoal-600">Name:</span> {user?.name || "—"}</p>
          <p className="flex items-center gap-2">
            <span className="text-ips-charcoal-600">Role:</span> <Badge>{user?.role}</Badge>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Change password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="space-y-3">
            <Input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            <Input type="password" placeholder="New password (min 10 chars)" value={next1} onChange={(e) => setNext1(e.target.value)} required />
            <Input type="password" placeholder="Confirm new password" value={next2} onChange={(e) => setNext2(e.target.value)} required />
            {msg && <p className={`text-xs ${msg.ok ? "text-green-600" : "text-ips-red"}`}>{msg.text}</p>}
            <Button type="submit">Update password</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function AccountPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <Suspense>
        <AccountContent />
      </Suspense>
    </div>
  );
}
