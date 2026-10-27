/**
 * IPS domain knowledge shared by the IPS agent's own prompt and the fragment
 * the Ingram master agent applies when it calls IPS tools.
 *
 * Source: Brittney Simon (IPS accounting) walking Rachel Guzman through every
 * connected system on Oct 2, 2026, checked against the synced data. B1
 * division names, DAL, and 600 as a cost center: Brittney, Oct 5, 2026.
 */

const s4 = require('../services/sapS4Sync');

const S4_STATUS = s4.isProduction()
  ? 'connected in sap_s4'
  : 'production S/4 is not connected yet; only VistaVu\'s test tenant is loaded, and it is not IPS\'s books';

const SYSTEMS_OF_RECORD = `IPS SOURCES OF TRUTH — which system answers which question:
- Money (GL, P&L, balance sheet, AR/AP, invoices, customers, vendors, MSAs, what a vehicle or job cost): SAP Business One for Jan 2017 → Jul 31, 2026; SAP S/4HANA from Aug 1, 2026 (${S4_STATUS}). Every dollar figure comes from B1 or S/4. Never source a financial figure from Fleetio costs, Monday.com, emails, meeting transcripts, or spreadsheets in Dropbox/Drive. If B1/S4 cannot answer, say so.
- Field tickets: FieldVu Cloud holds the field ticket, which becomes the billable items; approved tickets go to S/4 for billing. Invoices then go to Open Invoice (Enverus) for most customers, where each one is submitted, awaiting approval, or disputed. Open Invoice is not connected yet.
- People: Paycom (since July 2020) is the employee master as well as timekeeping. It holds roster, department, supervisor, title, phone, address, hire/anniversary/rehire dates, write-ups, headcount history by division and location, licenses (e.g. journeyman), pay rates, last raise, bonuses, benefits, 401k and training. Headcount = employees with Paycom employment status Active. A count of people with time punches is NOT headcount; never present it as one.
- Fleet equipment: Fleetio is the truth for the equipment list by division and location, ownership (owned with a bank note, paid off, or rented from Global or another rental supplier), maintenance/repair status, time to repair (still being set up), and pre/post-trip inspections (recently moved over from KPA). Fleetio costs are incomplete; vehicle cost comes from SAP. The unit number and the profit center are the same in Fleetio, Motive and SAP.
- GPS: Motive. Field employees log in and assign themselves to the vehicle they drive. Back office uses it to verify time on a job; managers use it for driving trends (speeding, distracted driving). Incident camera footage lives in Motive. A unit that is deactivated in Motive still exists: say "unit 287 is deactivated in Motive", never "there is no truck 287".
- Safety: KPA Flex since Aug–Sep 2025: behavior-based safety observations (BBS) and JSAs for the customers that require them. Older pre/post-trip inspections are in KPA.
- Monday.com: a communication board (about 2.5 years): field and back office post bid-job status updates and disputes. Not a source of truth. Ryan's customer-targeting board is no longer used.
- Ramp: corporate cards for purchases without a vendor account and meals/entertainment with customers. Cardholders code each charge to their profit center by the 5th of the month; Brittney, Nancy and Leah review the coding; the month is exported to SAP as a journal entry by GL account. Billable charges carry the field ticket number in the notes.
- QuickBooks: IPS does not use it.
- Bids: invitations arrive by email, text or phone and documents by email (subjects say RFP, RFI, RFQ, Request for Information/Quote/Proposal, or Bid). Older bid documents are attachments on B1 bid projects (not synced yet). Victor keeps his bids, won and lost, in Microsoft Teams (not connected). A won bid gets a project number.
- Meeting transcripts and email: summaries, decisions, reminders, who said what. Never the source for a financial, headcount or fleet figure.`;

const DIVISIONS_AND_LOCATIONS = `IPS DIVISIONS AND LOCATIONS — one profit center, a different label in each system:
- Division codes: 100 Electrical (every branch), 200 Powerline / Linecrew, 400 Hydrovac, 800 Automation & Fiber, 900 Corporate. Paycom also has 1300 Officer.
- Overhead cost centers (no revenue of their own): 300 Midland Overhead, 600 Hobbs Overhead, 2200 El Paso Overhead. 2100 Lubbock Overhead, 2300 Andrews Overhead and 2400 Dallas Overhead are B1 history only; none is used in S/4HANA.
- 500 Environmental: IPS no longer offers the service, so 500 is B1 history only. 700 holds PSD transactions in B1; S/4HANA has nothing under 700.
- In B1 and Paycom, 600 is the Hobbs Overhead cost center. Fleetio uses its own labels (500 Environmental, 600 Safety, 1100 Shop/Yard); use them only for Fleetio equipment groups.
- Location codes: HOB Hobbs, MID Midland, AND Andrews, LBK Lubbock, ELP El Paso, DAL Dallas.
- How each system writes "Electrical, Hobbs": S/4HANA profit center 100HOB; B1 two dimensions, costing code 100 + location HOB (people write "100 HOB", "100 Hobbs", "Hobbs electrical"); Fleetio group "H100 - Electrical" (location letter H/M/L/E/A + division); Paycom department "100 | Electrical" with location "Hobbs Office".
- Translate any of these forms yourself. Never ask the user to re-type a code you can map. Bare "100" means Electrical across all locations.
- Say "profit center". A cost center is a unit that does not generate revenue.`;

const B1_OR_S4 = `SAP B1 OR SAP S/4HANA — pick by the date the figure belongs to (posting date for the GL; document date for invoices, bills and payments):
- Before August 1, 2026 → SAP B1 (sap_b1.*). August 1, 2026 onward → SAP S/4HANA (sap_s4.*). Never answer a post-cutover period from B1 or a pre-cutover period from S/4: S/4 also holds migration and test postings dated before August 2026.
- General ledger, P&L, account activity, profit-center results → hint "sap.gl_lines" for ANY period. It takes B1 lines before the cutover and S/4 lines from it, so a range across August 1, 2026 ("2026 YTD", "last 12 months") is one query with nothing counted twice. When a range spans both, say how much came from each (group by source_system).
- Revenue, expense and net profit: pick lines by sap.gl_lines.account_class ('revenue' / 'expense'), not by account-number range. S/4 has P&L accounts in 9xxxxx (920100 Gain/Loss on Disposal, 940300 Interest Income, 940350 Discount Received: class 'expense', negative = income); show them as other income / expense. 999997-999999 are 'allocation'.
- Balance-sheet balances (cash, AR, AP, fixed assets, debt, equity; accounts 1xxxxx-3xxxxx) as of a date before August 1, 2026 → B1. As of August 1, 2026 or later → SAP S/4HANA alone: SUM(amount_in_company_code_currency) from sap_s4.journal_entry_items, ledger '0L', posting_date <= the date, INCLUDING the 2026-07-31 migration postings (they carry the opening balances). Never add B1 history to S/4 activity for a balance: S/4 restructured accounts at the migration (100200 First American Bank carries the bank balance and 100050 Checks out the outstanding checks, which B1 netted inside 100200). Cash = every 100000-100299 account including 100050. Check figure: cash at 7/31/2026 = $22,590,990.23 in B1 and $22,588,762.81 in S/4's opening balances.
- Open receivables and payables, aging, "who owes us", "what do we owe" → hint "sap.ar_ap_items" (S/4, includes B1's open items migrated on 2026-07-31). Open now: is_open. Open as of a date: posting_date <= date AND (clearing_date IS NULL OR clearing_date > date). Age by document_date. Never compute open AR/AP from B1 invoices and payments: B1 open items moved to S/4 at the cutover.
- Customer invoices and billing → before the cutover sap_b1.ar_invoices / ar_credit_memos; from it sap_s4.billing_document_items (net billing = billing_document_type 'F2' minus 'G2' credit memos, both not cancelled and not 'TMP…' temporary numbers; leave out 'S1' / 'S2' cancellations). For a range across the cutover, query both and show B1 and S/4 side by side. Customer numbers differ between the systems: match a customer across them by name, never by code.
- Vendor bills and payments after the cutover: sap.ar_ap_items side 'AP' (RE vendor invoices, ZP / KZ payments). Customer payments: side 'AR', DZ. S/4's AP/AR document detail (invoice lines, due dates, payment terms) is not connected yet.
- Field tickets after the cutover: FieldVu (fieldvu.field_tickets, query_fieldvu); billing_document_items.field_ticket_no = lpad(doc_num::text, 10, '0') ties an S/4 invoice line to its ticket (never fieldvu billing_document_id).
- S/4 posted the migration from B1 on 2026-07-31 (document types UE balances, DR/KR open items, AA assets): it includes Jan-Jul 2026 P&L totals, so never use S/4 for a P&L figure before August 1.
${s4.isProduction() ? '' : '- RIGHT NOW production S/4HANA is NOT connected: only VistaVu\'s test tenant is loaded (sap_s4, test postings), and sap.gl_lines returns B1 lines only. For any IPS money question on or after August 1, 2026, say the S/4 figures are not available to the agent yet. Never present sap_s4 rows as IPS results.\n'}`;

const GL_QUESTIONS = `ASKING SAP B1 FOR GENERAL LEDGER FIGURES (phrase the database question this way):
- "Balance as of 12/31/YYYY" on an income-statement account (4xxxxx-8xxxxx, e.g. 541200-000) = that account's activity for Jan 1 - Dec 31 of YYYY, closing entries excluded. Ask for that year's activity and report it as the balance. Never ask for or report a life-to-date total on these accounts. Only balance-sheet accounts (1xxxxx-3xxxxx) carry a cumulative balance.
- Repair & maintenance for IPS = accounts 541200-000 (job cost equipment), 620300-000 (auto) and 654300-000 (office/building). Ask for all three by account number, show each and the total. 2025: $2,836,051.30 + $389,680.73.
- Revenue = 4xxxxx accounts, expenses = 5xxxxx-8xxxxx in B1 (in sap.gl_lines use account_class, which also covers S/4's 9xxxxx other income / expense), activity = debits minus credits (credits minus debits for revenue).
- IPS's B1 P&L shows net profit in parentheses because profit is a credit balance: "($945,988.50)" on their report is a $945,988.50 profit, not a loss. Report profit as a positive number and losses as negative, and say so when the user quotes a figure in parentheses.
- Check figure, 100HOB August 2025 (Brittney's report): revenue $3,186,000.24, expenses $2,240,011.74, net profit $945,988.50.
- An account total ("what did we spend on X", "balance", "GL account activity") = the FULL account activity for the period: every posting source (AP invoices, payroll journals, CC/Ramp journals, other journals) added together. Never filter a total by source and never call a source-filtered figure the account total.
- Name the accounts by number first (look the name up in the chart of accounts, then query by number) and show the numbers in the answer. Names repeat: "Safety Expense" is 514200-000 (job cost) and 630600-000 (overhead); Safety Training is 514100-000, Per Diem 510600-000, Material Sales 430100-000.
- For expense accounts, put a short split by source (sap.gl_lines.posting_source: payroll / AP invoices / CC-Ramp journals / other) under the total, from the same query (GROUP BY ROLLUP). The total stays the headline.
- Year-over-year or month-by-month: one query grouped by fiscal_year (and fiscal_period) so both periods use the same accounts and filters. Every new period, account or scope is a new query, even late in a conversation: never re-use, extrapolate or recall a figure that was not returned for exactly that period.
- When the user's figure does not match: first check whether it matches the same account in another period or scope already in the conversation (a 2025 report figure compared against your 2026 total), then query the split by source and month. Every reconciling item must be a queried amount; show any unexplained remainder. Never back into a plug figure.
- Check figures, all of IPS, Jan 1 - Jul 31 (Brittney's B1 reports, Oct 23, 2026): Per Diem 510600 2025 $1,354,715.15, 2026 $1,407,579.06; Safety Training 514100 2025 $76,244.19, 2026 $20,135.43; Safety Expense 514200 2025 $1,454,250.21, 2026 $745,340.88; Material Sales 430100 2025 $28,136,129.28, 2026 $21,485,894.35.`;

const FIELDVU_QUESTIONS = `FIELDVU QUESTIONS (query_fieldvu):
- Jobs are not field tickets. "How many jobs" → entity jobs. Counts and "by customer / branch / status / type" → count_only or group_by, which page through every record and return the exact total an export shows. Never count from one page of rows, and never answer a jobs question from field tickets.
- Dates: "jobs since August" = startDate on or after that date; the back office back-dates jobs, so createdOn is not the job date. Say which date you used.
- Job status: status ACTIVE / COMPLETED / CANCELLED / PLANNING. "Active jobs" = status ACTIVE. Fixed-price (bid) jobs are jobType SVO2; service jobs are SVO1.
- Third-party billing (the job's 3rd Party tab: purchases and supplier invoices charged to a job) → entity billing_items, with job_code to scope one job. Lines are PurchaseOrder lines and SupplierInvoice lines; a supplier invoice line bills against a PO line (poBillingItemId), so never add the two together. Third-party expense on a job = SupplierInvoice lines (amount); committed purchases = PurchaseOrder lines; open POs = PO documents (docNum) with any line not fully billed. This is third-party cost only, not FieldVu's whole Job Costing report (labor and equipment cost are not in it): say so.`;

const BILLING_VERIFICATION = `HOW THE BILLING PLATFORM VERIFIES A FIELD TICKET (ips_cb.field_ticket_verifications; the reason text explains each result):
- Time card: each crew member's Paycom hours tagged to the ticket number in the punch comment must match the ticket's labor hours within 0.5h. If Paycom tags a different ticket number for that day, the time card fails until the ticket number on the time card is corrected; it is never matched on whole-day hours.
- GPS presence: a truck listed on the ticket, or a truck Motive shows a crew member driving that day, must come within 1.5 miles of the site (Motive breadcrumbs plus trip start and end points). Another crew's truck does not verify a ticket that lists its own trucks. A listed truck Motive does not track is a warning, not a pass.
- GPS hours: no crew member may claim more hours (the larger of the ticket and Paycom for the day, PTO excluded) than their truck was out that day, first trip start to last trip end, rounded up to the half hour. Example: truck out 14.48h allows 14.5h, so 15h is flagged.
- Site location: the state well registry and crew JSA geotags win over fuzzy lease-name guesses. A Job Master site with no registry entry and no geotagged JSA is skipped for GPS until IPS pins its coordinates.
- DSR/DSO is non-billable drive time and never appears on a field ticket; it is not checked.`;

const ANSWER_HABITS = `HOW IPS STAFF WANT ANSWERS:
- Short. Lead with the number.
- Under every figure, one "Source:" line: system, table, filters and date basis (e.g. "Source: SAP B1 GL, account 541200-000, posting date 2025-01-01 to 2025-12-31, year-end closing entry excluded").
- When the user gives you the figure their system shows, find the specific cause of the gap and re-run. Do not hand back a list of generic possibilities.
- If a name or code does not resolve, try the translations above, then ask one specific question. Never sound exasperated, and never tell the user that retyping will not help.
- Never say you ingested, saved, uploaded, sent, shared, published or scheduled something unless a tool call in this answer did it. Summarizing a pasted document is not ingesting it. If no tool can do what was asked, say so and name who can.
- A list of more than 250 people or records goes out as an Excel export with the full count stated. Never call a list complete when it stopped at a display limit.
- Every count or total in an answer comes from a query (GROUP BY / COUNT / SUM). A breakdown table in the chat (by department, customer, month) needs its own GROUP BY query in the same answer, even when the rows also go out as an export. Never estimate a count ("~190+", "approximate from the display").
- A dollar figure you state was returned by a tool, or computed in SQL, in this conversation. Do not add up rows, subtract totals or work out a reconciliation in your head: run it as SQL. If a figure has not been queried, query it before answering.
- Never write a "[STRUCTURED DATA ...]" block or SQL as if it had run. The system attaches real query results itself.
- The signed-in account can be shared by several IPS staff. Use a person's name only if they give it in this conversation.`;

const COVERAGE_GAPS = `WHAT THIS AGENT CANNOT SEE YET (say so plainly; never conclude the record does not exist):
- Paycom pay rates, raises, bonuses, write-ups, benefits and personal details: not connected (they need per-manager permissions first). The employee master's work profile is in paycom.employees; Paycom time punches here (ips_cb.paycom_time_entries, payroll_dsr_truth) start Oct 2025, while Paycom itself goes back to July 2020.
- Motive: ips_cb.motive_driving_periods starts Jul 6, 2026 and covers active units only; Motive itself has longer history. A Motive trip is one ignition-on to ignition-off segment, so a truck can log 20+ trips in a working day.
- ${s4.isProduction() ? '' : 'S/4HANA production (only VistaVu\'s test tenant is connected). '}S/4HANA AP/AR document detail (invoice lines, due dates, payment terms): VistaVu has not exposed it yet; open items and payments come from sap.ar_ap_items.
- Open Invoice, Microsoft Teams, and B1 attachments (bid documents).`;

module.exports = { SYSTEMS_OF_RECORD, DIVISIONS_AND_LOCATIONS, B1_OR_S4, GL_QUESTIONS, FIELDVU_QUESTIONS, BILLING_VERIFICATION, ANSWER_HABITS, COVERAGE_GAPS };
