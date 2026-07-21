"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import {
  Receipt,
  Truck,
  Clock3,
  HardHat,
  Mail,
  Mic,
  BookOpen,
  BarChart3,
  Sparkles,
  Copy,
  Check,
  Play,
  Lightbulb,
} from "lucide-react";

interface Tip {
  title: string;
  prompt: string;
}

interface TipSection {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  source: string;
  blurb: string;
  tips: Tip[];
}

const SECTIONS: TipSection[] = [
  {
    id: "billing",
    icon: Receipt,
    label: "Field Tickets, Invoices & SAP Billing",
    source: "IPS Billing platform · synced with SAP + FieldVu",
    blurb:
      "The agent can query field tickets, invoices, billing exceptions, and customer records straight from the billing platform — the same data that flows to SAP and Ariba.",
    tips: [
      {
        title: "Unapproved field tickets",
        prompt:
          "Show me all field tickets from the last 14 days that haven't been approved yet. Group them by customer and include ticket number, date, location, and work type.",
      },
      {
        title: "Invoiced vs paid",
        prompt:
          "Which invoices have been posted to SAP but not yet paid? List invoice number, customer, total, and days outstanding, sorted by the largest amounts first.",
      },
      {
        title: "Revenue by customer",
        prompt:
          "What's our total invoiced amount this month compared to last month? Break it down by customer and show the change.",
      },
      {
        title: "Open billing exceptions",
        prompt:
          "List all open billing exceptions by priority. For each one include the exception type, the AI-suggested resolution, and who it's assigned to.",
      },
      {
        title: "PO / AFE lookup",
        prompt:
          "Find all invoices tied to AFE number [enter AFE] — show totals, billing periods, and current status.",
      },
    ],
  },
  {
    id: "fleet",
    icon: Truck,
    label: "Fleet & GPS (Motive)",
    source: "Motive driving periods + GPS snapshots",
    blurb:
      "Every vehicle's driving history from Motive is available — who drove what, where, and how far.",
    tips: [
      {
        title: "Top mileage last week",
        prompt:
          "Which vehicles drove the most miles last week according to Motive? Show vehicle unit, driver name, and total miles.",
      },
      {
        title: "Vehicle day trace",
        prompt:
          "Show me everywhere unit [vehicle #] traveled yesterday — start and end times, origins, destinations, and miles for each driving period.",
      },
      {
        title: "GPS vs reported time",
        prompt:
          "For last Friday, compare GPS minutes to DSR-reported minutes by crew and flag any crew where the difference is more than 60 minutes.",
      },
      {
        title: "Driver activity summary",
        prompt:
          "Summarize driving activity for [driver name] over the past two weeks — days active, total miles, and the most common destinations.",
      },
    ],
  },
  {
    id: "payroll",
    icon: Clock3,
    label: "Payroll & Time (Paycom)",
    source: "Paycom time entries + payroll verification data",
    blurb:
      "Paycom time entries and the payroll verification tables let you sanity-check hours before payroll runs.",
    tips: [
      {
        title: "Weekly hours rollup",
        prompt:
          "Summarize Paycom time entries for last week — total hours by employee, and flag anyone over 55 hours.",
      },
      {
        title: "Missing time check",
        prompt:
          "Which employees have Motive driving activity last week but no matching Paycom time entries on the same days?",
      },
      {
        title: "Crew hours by day",
        prompt:
          "Show total recorded hours by crew for each day last week, so I can spot days that look light or heavy.",
      },
    ],
  },
  {
    id: "safety",
    icon: HardHat,
    label: "Safety & JSAs (KPA)",
    source: "KPA JSA records — hazards, PPE, job sites",
    blurb:
      "JSA submissions from KPA are queryable — use them for compliance checks and to build better safety briefings.",
    tips: [
      {
        title: "JSA compliance pulse",
        prompt:
          "How many JSAs were submitted last week and which job sites had the most? List any sites with crews working but no JSA on file.",
      },
      {
        title: "Recurring hazards",
        prompt:
          "What hazards show up most often in JSA records from the past 30 days? Rank them and note which job sites they came from.",
      },
      {
        title: "Data-driven toolbox talk",
        prompt:
          "Draft a 5-minute toolbox talk based on the three most common hazards in our recent JSA records, written for an oilfield electrical crew.",
      },
    ],
  },
  {
    id: "email",
    icon: Mail,
    label: "Your Email (Microsoft 365)",
    source: "Last 30 days synced · you see only your own mailbox (admins see all)",
    blurb:
      "The agent can search your synced Microsoft 365 email. Regular users can only search their own mailbox; admins can search across the company.",
    tips: [
      {
        title: "Catch up on a customer",
        prompt:
          "Search my email for anything from Oxy in the last two weeks about billing or invoices, and summarize the key points.",
      },
      {
        title: "Find a decision",
        prompt:
          "Find the most recent email thread about the S4 migration and tell me what was decided and what's still open.",
      },
      {
        title: "Morning digest",
        prompt:
          "Summarize my unread-worthy email from the last 3 days — group by topic and flag anything that looks like it needs a reply.",
      },
    ],
  },
  {
    id: "meetings",
    icon: Mic,
    label: "Meeting Transcripts (Read.ai)",
    source: "Every recorded meeting, auto-ingested — 3 months of history loaded",
    blurb:
      "Recorded meetings flow in automatically with summaries, action items, and full transcripts. Ask about anything that was said.",
    tips: [
      {
        title: "Huddle recap",
        prompt:
          "What was decided in the most recent Management Weekly Huddle? List the action items and who owns each one.",
      },
      {
        title: "Topic history",
        prompt:
          "Summarize everything we've discussed about Oxy billing in meetings over the past three months, in chronological order.",
      },
      {
        title: "My action items",
        prompt:
          "Search recent meeting transcripts for action items assigned to [your name] and list them with the meeting and date they came from.",
      },
      {
        title: "Missed-meeting catch-up",
        prompt:
          "I missed the Hobbs Updates/Aging meeting — give me a 5-bullet recap and anything that needs my attention.",
      },
    ],
  },
  {
    id: "knowledge",
    icon: BookOpen,
    label: "Company Knowledge",
    source: "ipsaecorp.com content + uploaded documents",
    blurb:
      "The knowledge base covers IPS's services and site content, plus any documents you upload in chat (PDF, Word, Excel, CSV).",
    tips: [
      {
        title: "Service explainer",
        prompt:
          "What services does IPS offer, and what makes each one different? Write it as a short intro I could send a new customer.",
      },
      {
        title: "Ask a document",
        prompt:
          "(Attach a file first, then ask:) Review this rate sheet and tell me which line items changed the most from our standard rates.",
      },
      {
        title: "New-hire orientation",
        prompt:
          "Write a one-page 'welcome to IPS' overview for a new field hire — who we are, what we do, and the areas we serve.",
      },
    ],
  },
  {
    id: "reports",
    icon: BarChart3,
    label: "Charts, Reports & Documents",
    source: "Interactive artifacts — charts, dashboards, PDFs, drafts",
    blurb:
      "Ask for a chart, dashboard, or document and it renders in a side panel you can export or copy. Great for turning any query into something you can share.",
    tips: [
      {
        title: "Revenue chart",
        prompt:
          "Create a bar chart of invoiced totals by customer for the last 90 days.",
      },
      {
        title: "Weekly ops one-pager",
        prompt:
          "Build a one-page summary of this week's activity — field tickets created and approved, invoices posted, open exceptions, and fleet miles — formatted so I can share it with management.",
      },
      {
        title: "Trend dashboard",
        prompt:
          "Make a dashboard showing field ticket volume per week for the last 12 weeks, split by work type.",
      },
      {
        title: "Draft a customer email",
        prompt:
          "Draft a professional email to a customer explaining a billing correction on invoice [number] — keep it short and factual.",
      },
    ],
  },
  {
    id: "power",
    icon: Sparkles,
    label: "Power Moves — Combine Sources",
    source: "The real magic: one question across databases, email, and meetings",
    blurb:
      "The agent can pull from multiple sources in a single request. These take longer but answer questions no single system can.",
    tips: [
      {
        title: "Meeting prep pack",
        prompt:
          "Prep me for my next meeting with Oxy: recent invoices and their status, any open billing exceptions, what was said about them in recent meeting transcripts, and any email threads I have with them from the last two weeks.",
      },
      {
        title: "Crew day audit",
        prompt:
          "For last Monday, cross-check crew [name]: field tickets they worked, Motive driving time, and Paycom hours — flag anything inconsistent.",
      },
      {
        title: "Customer 360",
        prompt:
          "Give me a full picture of [customer]: total invoiced this year, unpaid balance, open exceptions, recent field ticket activity, and the last time they came up in a meeting.",
      },
      {
        title: "What are we connected to?",
        prompt: "What data sources are you connected to? Give me the quick tour.",
      },
    ],
  },
];

const USAGE_TIPS = [
  "Be specific: name the customer, crew, vehicle unit, or date range. \u201cInvoices for Oxy in June\u201d beats \u201cshow me invoices.\u201d",
  "Ask for the format you want: \u201cas a table,\u201d \u201cas a bar chart,\u201d \u201cas a one-page summary,\u201d \u201cas an email draft.\u201d",
  "Follow up in the same chat — the agent remembers the conversation, so you can say \u201cnow just show Q2\u201d or \u201cchart that.\u201d",
  "Upload files right in chat (PDF, Word, Excel, CSV, images) and ask questions about them.",
  "Use the mic button to dictate instead of typing.",
  "Give a thumbs up or down on answers — feedback trains the agent on what good looks like.",
  "Save prompts you reuse via the book icon next to the chat box.",
];

export default function TipsPage() {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);

  function copyPrompt(key: string, prompt: string) {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  function tryPrompt(prompt: string) {
    try {
      sessionStorage.setItem("ips-tip-prompt", prompt);
    } catch {
      /* ignore */
    }
    router.push("/ai-chat");
  }

  return (
    <div className="flex flex-col h-screen">
      <Header />
      <main className="flex-1 overflow-y-auto bg-ips-surface">
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-ips-charcoal flex items-center gap-2">
              <Lightbulb className="h-6 w-6 text-ips-red" />
              Platform Tips
            </h1>
            <p className="text-ips-charcoal-600 mt-2 max-w-3xl">
              The IPS AI Brain is connected to your billing platform (SAP field tickets and
              invoices), Motive fleet GPS, Paycom time entries, KPA safety records, Microsoft 365
              email, Read.ai meeting transcripts, and the company knowledge base. Here are
              specific things you can ask it today — click <strong>Try it</strong> on any example
              to load it into a chat.
            </p>
          </div>

          {/* quick-jump */}
          <div className="flex flex-wrap gap-2 mb-8">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-xs bg-white border border-ips-border rounded-full px-3 py-1.5 text-ips-charcoal hover:border-ips-red hover:text-ips-red transition-colors"
              >
                {s.label}
              </a>
            ))}
          </div>

          <div className="space-y-8">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <section key={section.id} id={section.id} className="scroll-mt-4">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="bg-ips-red/10 rounded-lg p-2 mt-0.5">
                      <Icon className="h-5 w-5 text-ips-red" />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-ips-charcoal">{section.label}</h2>
                      <div className="text-[11px] uppercase tracking-wide text-ips-steel font-medium">
                        {section.source}
                      </div>
                      <p className="text-sm text-ips-charcoal-600 mt-1 max-w-3xl">{section.blurb}</p>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3">
                    {section.tips.map((tip, i) => {
                      const key = `${section.id}-${i}`;
                      return (
                        <div
                          key={key}
                          className="bg-white border border-ips-border rounded-lg p-4 flex flex-col hover:shadow-sm transition-shadow"
                        >
                          <div className="font-medium text-sm text-ips-charcoal mb-1.5">
                            {tip.title}
                          </div>
                          <p className="text-[13px] text-ips-charcoal-600 leading-relaxed flex-1">
                            &ldquo;{tip.prompt}&rdquo;
                          </p>
                          <div className="flex items-center gap-2 mt-3">
                            <button
                              onClick={() => tryPrompt(tip.prompt)}
                              className="inline-flex items-center gap-1.5 text-xs font-medium bg-ips-red text-white rounded px-2.5 py-1.5 hover:bg-ips-red-dark transition-colors"
                            >
                              <Play className="h-3 w-3" />
                              Try it
                            </button>
                            <button
                              onClick={() => copyPrompt(key, tip.prompt)}
                              className="inline-flex items-center gap-1.5 text-xs text-ips-charcoal-600 border border-ips-border rounded px-2.5 py-1.5 hover:border-ips-charcoal transition-colors"
                            >
                              {copied === key ? (
                                <>
                                  <Check className="h-3 w-3 text-ips-red" /> Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" /> Copy
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          {/* usage tips */}
          <section className="mt-10 bg-ips-charcoal rounded-lg p-6">
            <h2 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-ips-red" />
              Getting the best answers
            </h2>
            <ul className="grid md:grid-cols-2 gap-x-8 gap-y-2">
              {USAGE_TIPS.map((t, i) => (
                <li key={i} className="text-[13px] text-gray-300 flex gap-2">
                  <span className="text-ips-red font-bold shrink-0">·</span>
                  {t}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
