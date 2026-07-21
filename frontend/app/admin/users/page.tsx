"use client";
import { useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { KeyRound, UserPlus } from "lucide-react";

interface User {
  id: number;
  email: string;
  name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("user");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/admin/users", { credentials: "include" });
    if (res.ok) setUsers(await res.json());
    else setError("Admin access required");
  }
  useEffect(() => { load(); }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null); setError(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, role }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Failed to create user");
    setNotice(`User created — temporary password: ${data.temp_password}`);
    setEmail(""); setName("");
    load();
  }

  async function setUserRole(id: number, newRole: string) {
    await fetch(`/api/admin/users/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    load();
  }

  async function toggleActive(u: User) {
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    load();
  }

  async function resetPassword(id: number) {
    const res = await fetch(`/api/admin/users/${id}/reset-password`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok) setNotice(`Temporary password: ${data.temp_password}`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-semibold text-ips-charcoal">User management</h1>

        {notice && (
          <div className="border border-green-300 bg-green-50 text-green-800 rounded-lg px-3 py-2 text-sm font-mono">
            {notice}
          </div>
        )}
        {error && <p className="text-sm text-ips-red">{error}</p>}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-ips-red" /> Create user
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={createUser} className="flex flex-wrap gap-2 items-center">
              <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-56" />
              <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="w-44" />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="h-10 rounded-md border border-ips-border bg-white px-2 text-sm"
              >
                <option value="user">User</option>
                <option value="user_manager">User manager</option>
                <option value="admin">Admin</option>
              </select>
              <Button type="submit">Create</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Users ({users.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {users.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center gap-2 border-b border-ips-border pb-2 last:border-0 text-sm">
                  <span className="font-medium w-56 truncate">{u.email}</span>
                  <span className="text-ips-charcoal-600 w-32 truncate">{u.name || "—"}</span>
                  <select
                    value={u.role}
                    onChange={(e) => setUserRole(u.id, e.target.value)}
                    className="h-8 rounded border border-ips-border bg-white px-1.5 text-xs"
                  >
                    <option value="user">user</option>
                    <option value="user_manager">user_manager</option>
                    <option value="admin">admin</option>
                  </select>
                  <Badge variant={u.is_active ? "steel" : "outline"}>
                    {u.is_active ? "active" : "disabled"}
                  </Badge>
                  <span className="ml-auto flex gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => resetPassword(u.id)}>
                      <KeyRound className="h-3 w-3" /> Reset PW
                    </Button>
                    <Button variant={u.is_active ? "danger" : "secondary"} size="sm" onClick={() => toggleActive(u)}>
                      {u.is_active ? "Disable" : "Enable"}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
