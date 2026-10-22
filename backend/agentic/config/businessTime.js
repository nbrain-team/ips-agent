/**
 * What "today" means for Ingram.
 *
 * The agent used to derive its calendar date with
 * `new Date().toISOString().slice(0, 10)`. On a Render host that is UTC, which
 * is five or six hours ahead of Central depending on the season. So from about
 * 6pm Central every day the agent believed it was tomorrow — and asked for "this
 * week's field tickets" or "yesterday's deposits" it would silently shift the
 * window by a day.
 *
 * That misreads as a retrieval problem rather than a clock problem, which is why
 * it survived: nothing errors, the SQL is valid, rows come back, and the numbers
 * are simply for the wrong day. The person reading the answer has no way to see
 * it except by already knowing the right number.
 *
 * The zone is Central by default because that is where the operating businesses
 * and the people asking about them are — IPS in West Texas, Tea It Up in El
 * Paso, PSD, and Philip and Rachel. Danny is Pacific and Studio Golf spans
 * Pacific and Arizona, so nobody is perfectly served by a single zone; the
 * choice is which drift window is smallest. Central leaves Pacific users a
 * two-hour disagreement late at night against UTC's six, and it puts the
 * boundary where the field work, payroll, and billing actually close out.
 *
 * Override with BUSINESS_TIMEZONE. The zone is always stated in the prompt
 * rather than assumed, so an answer near midnight can be read correctly.
 */

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

const MS_PER_DAY = 86400000;

/**
 * en-CA formats as YYYY-MM-DD, which is the shape every query in this codebase
 * expects. Built once — constructing an Intl formatter is not cheap and this
 * runs on every turn.
 */
const isoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const humanStamp = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/**
 * Calendar date in the business zone, YYYY-MM-DD.
 *
 * Intl does the arithmetic rather than an offset subtraction, so daylight
 * saving is handled by the zone database instead of by a constant that is wrong
 * for part of the year.
 */
function todayISO(at = new Date()) {
  return isoDate.format(at);
}

/**
 * N days before today, as a business-zone calendar date.
 *
 * Steps by whole days from the instant and re-formats in the business zone, so
 * the two DST transitions each year do not produce a repeated or skipped date
 * the way subtracting from a UTC string does.
 */
function daysAgoISO(n, at = new Date()) {
  return isoDate.format(new Date(at.getTime() - n * MS_PER_DAY));
}

function daysAheadISO(n, at = new Date()) {
  return daysAgoISO(-n, at);
}

/** First day of the current business-zone month, YYYY-MM-DD. */
function monthStartISO(at = new Date()) {
  return `${todayISO(at).slice(0, 7)}-01`;
}

/**
 * Human-readable timestamp including the zone abbreviation, e.g.
 * "Wednesday, August 26, 2026 at 2:14 PM CDT".
 *
 * The zone name is not decoration. It is how a reader tells whether an answer
 * given at 11pm Pacific was reasoning about today or tomorrow.
 */
function nowLabel(at = new Date()) {
  return humanStamp.format(at).replace(',' + ' ', ', ');
}

/**
 * Format a timestamp that came out of the database as a business-zone calendar
 * date. Returns null for null, rather than the epoch.
 */
function toBusinessDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : isoDate.format(d);
}

/**
 * The block that goes into the system prompt.
 *
 * States the zone alongside the date on purpose. A model told only "today is
 * 2026-08-26" cannot caveat a late-evening answer; one told the zone can.
 */
function promptBlock(at = new Date()) {
  return [
    `Current date and time: ${nowLabel(at)}`,
    `Today (${BUSINESS_TIMEZONE}): ${todayISO(at)}`,
    `Yesterday: ${daysAgoISO(1, at)} · 7 days ago: ${daysAgoISO(7, at)} · 30 days ago: ${daysAgoISO(30, at)}`,
    `All dates you produce or filter on are ${BUSINESS_TIMEZONE} calendar dates, not UTC.`,
  ].join('\n');
}

module.exports = {
  BUSINESS_TIMEZONE,
  todayISO,
  daysAgoISO,
  daysAheadISO,
  monthStartISO,
  nowLabel,
  toBusinessDate,
  promptBlock,
};
