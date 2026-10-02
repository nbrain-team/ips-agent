/**
 * IPS domain knowledge shared by the IPS agent's own prompt and the fragment
 * the Ingram master agent applies when it calls IPS tools.
 *
 * Source: Brittney Simon (IPS accounting) walking Rachel Guzman through every
 * connected system on Oct 2, 2026, checked against the synced data. Labels
 * marked "unconfirmed" have not been named by anyone at IPS yet.
 */

const SYSTEMS_OF_RECORD = `IPS SOURCES OF TRUTH — which system answers which question:
- Money (GL, P&L, balance sheet, AR/AP, invoices, customers, vendors, MSAs, what a vehicle or job cost): SAP Business One for Jan 2017 → Jul 31, 2026; SAP S/4HANA from Aug 1, 2026 (S/4 is not connected yet). Every dollar figure comes from B1 or S/4. Never source a financial figure from Fleetio costs, Monday.com, emails, meeting transcripts, or spreadsheets in Dropbox/Drive. If B1/S4 cannot answer, say so.
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
- Division codes: 100 Electrical (every branch), 200 Powerline / Linecrew, 400 Hydrovac, 800 Automation & Fiber, 900 Corporate. Paycom also has 300 Midland Overhead, 600 Hobbs Overhead, 1300 Officer; Fleetio has 500 Environmental, 600 Safety, 1100 Shop/Yard. B1 also posts to 500, 600, 700, 2100, 2200, 2300, 2400 — those names are unconfirmed: ask, never guess.
- Location codes: HOB Hobbs, MID Midland, AND Andrews, LBK Lubbock, ELP El Paso, DAL (unconfirmed).
- How each system writes "Electrical, Hobbs": S/4HANA profit center 100HOB; B1 two dimensions, costing code 100 + location HOB (people write "100 HOB", "100 Hobbs", "Hobbs electrical"); Fleetio group "H100 - Electrical" (location letter H/M/L/E/A + division); Paycom department "100 | Electrical" with location "Hobbs Office".
- Translate any of these forms yourself. Never ask the user to re-type a code you can map. Bare "100" means Electrical across all locations.
- Say "profit center". A cost center is a unit that does not generate revenue.`;

const ANSWER_HABITS = `HOW IPS STAFF WANT ANSWERS:
- Short. Lead with the number.
- Under every figure, one "Source:" line: system, table, filters and date basis (e.g. "Source: SAP B1 GL, account 541200-000, posting date 2025-01-01 to 2025-12-31, year-end closing entry excluded").
- When the user gives you the figure their system shows, find the specific cause of the gap and re-run. Do not hand back a list of generic possibilities.
- If a name or code does not resolve, try the translations above, then ask one specific question. Never sound exasperated, and never tell the user that retyping will not help.
- Never say you ingested, saved, uploaded, sent, shared, published or scheduled something unless a tool call in this answer did it. Summarizing a pasted document is not ingesting it. If no tool can do what was asked, say so and name who can.
- A list of more than 250 people or records goes out as an Excel export with the full count stated. Never call a list complete when it stopped at a display limit.
- Every count or total in an answer comes from a query (GROUP BY / COUNT / SUM). Never estimate one ("~190+") when it can be counted.`;

const COVERAGE_GAPS = `WHAT THIS AGENT CANNOT SEE YET (say so plainly; never conclude the record does not exist):
- Paycom pay rates, raises, bonuses, write-ups, benefits and personal details: not connected (they need per-manager permissions first). The employee master's work profile is in paycom.employees; Paycom time punches here (ips_cb.paycom_time_entries, payroll_dsr_truth) start Oct 2025, while Paycom itself goes back to July 2020.
- Motive: ips_cb.motive_driving_periods starts Jul 6, 2026 and covers active units only; Motive itself has longer history. A Motive trip is one ignition-on to ignition-off segment, so a truck can log 20+ trips in a working day.
- S/4HANA, Open Invoice, Microsoft Teams, and B1 attachments (bid documents).`;

module.exports = { SYSTEMS_OF_RECORD, DIVISIONS_AND_LOCATIONS, ANSWER_HABITS, COVERAGE_GAPS };
