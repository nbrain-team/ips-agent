"use client";
import { useCallback, useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Mic,
  Globe,
  Table2,
  AlertTriangle,
  RefreshCw,
  DollarSign,
  BarChart3,
  CheckCircle2,
} from "lucide-react";

interface Health {
  email: {
    configured: boolean;
    mailboxes: { total?: number; ok?: number; error?: number; last_synced_at?: string };
    messages: { total?: number; latest?: string; attachments?: number };
  };
  meetings: { total?: number; latest_meeting?: string; last_ingested?: string };
  table_vectors: { source_tag: string; tables: number; last_profiled: string }[];
  website: { pages?: number; last_crawled?: string };
  knowledge_chunks: number;
  billing_db: string;
  open_failures: number;
  jobs: {
    crawl: { running: boolean; last_finished_at?: string; last_exit?: number | null };
    vectorize: { running: boolean; last_finished_at?: string; last_error?: string | null };
  };
}

interface Usage {
  days: number;
  totals: { tokens: number; est_cost_usd: number; messages: number };
  daily: { day: string; messages: number; tokens: number }[];
  by_user: { email: string; messages: number; tokens: number }[];
  by_model: { model: string; responses: number; tokens: number; est_cost_usd: number }[];
  by_mode: { mode: string; runs: number; avg_latency_ms: number; avg_confidence: number }[];
}

interface Failure {
  id: number;
  source: string;
  reference: string | null;
  error: string;
  created_at: string;
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function fmtNum(n?: number) {
  if (n == null) return "—";
  return n.toLocaleString();
}

export default function AdminOpsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [h, u, f] = await Promise.all([
      fetch("/api/admin/ops/health", { credentials: "include" }),
      fetch("/api/admin/ops/usage", { credentials: "include" }),
      fetch("/api/admin/ops/failures", { credentials: "include" }),
    ]);
    if (!h.ok) {
      setError("Admin access required");
      return;
    }
    setHealth(await h.json());
    if (u.ok) setUsage(await u.json());
    if (f.ok) setFailures(await f.json());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function trigger(name: string, url: string) {
    setBusy(name);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) setNotice(data.error || `${name} failed`);
      else setNotice(`${name} started — refresh in a minute to see results.`);
    } catch {
      setNotice(`${name} failed`);
    }
    setBusy(null);
    setTimeout(load, 2000);
  }

  async function resolveFailure(id: number) {
    await fetch(`/api/admin/ops/failures/${id}/resolve`, { method: "POST", credentials: "include" });
    load();
  }

  const maxDailyTokens = Math.max(1, ...(usage?.daily.map((d) => d.tokens) || [1]));

  return (
    <div className="min-h-screen bg-ips-surface">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-ips-charcoal">Operations</h1>
            <p className="text-sm text-ips-charcoal-600">
              Sync health, usage analytics, and ingest failures.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => trigger("Email sync", "/api/admin/sync-emails")}
            >
              <Mail className="h-4 w-4 mr-1.5" /> Sync emails now
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || health?.jobs.crawl.running}
              onClick={() => trigger("Website crawl", "/api/admin/ops/crawl")}
            >
              <Globe className="h-4 w-4 mr-1.5" />
              {health?.jobs.crawl.running ? "Crawl running..." : "Re-crawl website"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || health?.jobs.vectorize.running}
              onClick={() => trigger("Table re-profiling", "/api/admin/ops/vectorize")}
            >
              <Table2 className="h-4 w-4 mr-1.5" />
              {health?.jobs.vectorize.running ? "Profiling running..." : "Re-profile tables"}
            </Button>
          </div>
        </div>

        {error && <div className="text-ips-red text-sm">{error}</div>}
        {notice && <div className="text-sm text-ips-steel">{notice}</div>}

        {/* Sync health */}
        {health && (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Mail className="h-4 w-4 text-ips-steel" /> Email sync
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <div className="text-2xl font-bold text-ips-charcoal">
                  {fmtNum(health.email.messages.total)}
                  <span className="text-xs font-normal text-ips-charcoal-600 ml-1">messages</span>
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  {fmtNum(health.email.mailboxes.ok)} of {fmtNum(health.email.mailboxes.total)} mailboxes OK
                  {(health.email.mailboxes.error || 0) > 0 && (
                    <span className="text-ips-red"> · {health.email.mailboxes.error} failing</span>
                  )}
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  {fmtNum(health.email.messages.attachments)} searchable attachments
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  Last sync: {fmtDate(health.email.mailboxes.last_synced_at)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Mic className="h-4 w-4 text-ips-steel" /> Meeting transcripts
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <div className="text-2xl font-bold text-ips-charcoal">
                  {fmtNum(health.meetings.total)}
                  <span className="text-xs font-normal text-ips-charcoal-600 ml-1">meetings</span>
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  Latest meeting: {fmtDate(health.meetings.latest_meeting)}
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  Last ingested: {fmtDate(health.meetings.last_ingested)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Globe className="h-4 w-4 text-ips-steel" /> Knowledge base
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <div className="text-2xl font-bold text-ips-charcoal">
                  {fmtNum(health.knowledge_chunks)}
                  <span className="text-xs font-normal text-ips-charcoal-600 ml-1">chunks</span>
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  {fmtNum(health.website.pages)} website pages
                </div>
                <div className="text-xs text-ips-charcoal-600">
                  Last crawl: {fmtDate(health.website.last_crawled)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Table2 className="h-4 w-4 text-ips-steel" /> Data layer
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                {health.table_vectors.map((v) => (
                  <div key={v.source_tag} className="text-xs text-ips-charcoal-600">
                    <span className="font-semibold text-ips-charcoal">{v.tables}</span> {v.source_tag} tables
                    · profiled {fmtDate(v.last_profiled)}
                  </div>
                ))}
                <div className="text-xs text-ips-charcoal-600">
                  Billing DB: <span className="font-medium">{health.billing_db}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Usage analytics */}
        {usage && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-ips-steel" /> Usage — last {usage.days} days
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-2xl font-bold text-ips-charcoal">{fmtNum(usage.totals.messages)}</div>
                  <div className="text-xs text-ips-charcoal-600">User messages</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-ips-charcoal">{fmtNum(usage.totals.tokens)}</div>
                  <div className="text-xs text-ips-charcoal-600">Tokens used</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-ips-charcoal flex items-center gap-1">
                    <DollarSign className="h-5 w-5 text-ips-steel" />
                    {usage.totals.est_cost_usd.toFixed(2)}
                  </div>
                  <div className="text-xs text-ips-charcoal-600">Estimated LLM cost</div>
                </div>
              </div>

              {/* Daily tokens bar chart */}
              {usage.daily.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-ips-charcoal-600 uppercase mb-2">
                    Daily token usage
                  </div>
                  <div className="flex items-end gap-1 h-24">
                    {usage.daily.map((d) => (
                      <div
                        key={d.day}
                        className="flex-1 bg-ips-steel/70 hover:bg-ips-steel rounded-t min-w-[4px]"
                        style={{ height: `${Math.max(4, (d.tokens / maxDailyTokens) * 100)}%` }}
                        title={`${new Date(d.day).toLocaleDateString()}: ${d.tokens.toLocaleString()} tokens · ${d.messages} messages`}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <div className="text-xs font-semibold text-ips-charcoal-600 uppercase mb-2">By model</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {usage.by_model.map((m) => (
                        <tr key={m.model} className="border-b border-ips-border last:border-0">
                          <td className="py-1.5 font-medium text-ips-charcoal">{m.model}</td>
                          <td className="py-1.5 text-right text-ips-charcoal-600">{fmtNum(m.responses)} resp</td>
                          <td className="py-1.5 text-right text-ips-charcoal-600">{fmtNum(m.tokens)} tok</td>
                          <td className="py-1.5 text-right text-ips-charcoal-600">${m.est_cost_usd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-xs font-semibold text-ips-charcoal-600 uppercase mb-2">Top users</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {usage.by_user.slice(0, 8).map((u) => (
                        <tr key={u.email} className="border-b border-ips-border last:border-0">
                          <td className="py-1.5 font-medium text-ips-charcoal truncate max-w-[180px]">{u.email}</td>
                          <td className="py-1.5 text-right text-ips-charcoal-600">{fmtNum(u.messages)} msgs</td>
                          <td className="py-1.5 text-right text-ips-charcoal-600">{fmtNum(u.tokens)} tok</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {usage.by_mode.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-ips-charcoal-600 uppercase mb-2">By mode</div>
                  <div className="flex flex-wrap gap-2">
                    {usage.by_mode.map((m) => (
                      <Badge key={m.mode} variant="secondary" className="font-normal">
                        {m.mode}: {fmtNum(m.runs)} runs · {(m.avg_latency_ms / 1000).toFixed(1)}s avg
                        {m.avg_confidence != null && ` · ${Math.round(Number(m.avg_confidence) * 100)}% conf`}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Failure inbox */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-ips-red" /> Ingest failures
              {failures.length > 0 && <Badge>{failures.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {failures.length === 0 ? (
              <div className="text-sm text-ips-charcoal-600 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" /> No open ingest failures.
              </div>
            ) : (
              <div className="space-y-2">
                {failures.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start justify-between gap-3 border border-ips-border rounded p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary">{f.source}</Badge>
                        {f.reference && <span className="font-medium text-ips-charcoal truncate">{f.reference}</span>}
                        <span className="text-xs text-ips-charcoal-600">{fmtDate(f.created_at)}</span>
                      </div>
                      <div className="text-xs text-ips-red mt-1 break-words">{f.error}</div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => resolveFailure(f.id)}>
                      Resolve
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="text-xs text-ips-charcoal-600 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Auto-refreshes every 30 seconds. Cost figures are directional
          estimates from blended per-model token rates.
        </div>
      </main>
    </div>
  );
}
