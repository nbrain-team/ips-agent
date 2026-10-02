/**
 * search_calendar — live Microsoft 365 calendar lookup via Graph (app token).
 * Permission scoping mirrors email: regular users see ONLY their own calendar,
 * admins can look at anyone's. Requires the Calendars.Read APPLICATION
 * permission (admin consent) in the IPS tenant — degrades with a clear error
 * if consent hasn't been granted yet.
 */
const msGraph = require('../services/msGraph');

const TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

/**
 * A Graph event time as UTC plus a local reading that names its own zone.
 *
 * The times used to go out as bare wall-clock in Mountain time. The Ingram
 * Brain reads federated times as Central, so every meeting came back an hour
 * early ("Pre-Planning 2:30 PM CT" for a 3:30 PM CT meeting, Oct 2).
 */
function eventTime(t, allDay) {
  if (!t?.dateTime) return { utc: null, local: null };
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`);
  if (allDay) return { utc: d.toISOString(), local: t.dateTime.slice(0, 10) };
  const local = d.toLocaleString('en-US', {
    timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return { utc: d.toISOString(), local };
}

module.exports = {
  name: 'search_calendar',
  description: `Look up Microsoft 365 calendar events — meetings, appointments, schedules. Live query, always current.

WHEN TO USE: "what's on my calendar today/this week?", "when is my next meeting with X?", "am I free Thursday afternoon?", "what meetings does the team have tomorrow?".

PERMISSIONS (enforced automatically): regular users see ONLY their own calendar; admins can specify another person's mailbox.`,
  category: 'calendar',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      days_ahead: {
        type: 'number',
        description: 'How many days forward to look (default 7, max 60).',
      },
      days_back: {
        type: 'number',
        description: 'How many days back to include (default 0, max 30).',
      },
      mailbox: {
        type: 'string',
        description: "ADMIN ONLY: another person's email address to view their calendar.",
      },
    },
    required: [],
  },
  async execute(params, context) {
    try {
      if (!msGraph.isConfigured()) {
        return { success: false, error: 'Microsoft 365 is not configured on this deployment.', confidence: 0 };
      }
      const isAdmin = context.userRole === 'admin';
      const ownEmail = (context.userEmail || '').toLowerCase();
      let target = ownEmail;
      if (params.mailbox) {
        if (!isAdmin && params.mailbox.toLowerCase() !== ownEmail) {
          return {
            success: false,
            error: "Permission denied: only admins can view other people's calendars.",
            confidence: 0,
          };
        }
        target = params.mailbox.toLowerCase();
      }
      if (!target) {
        return { success: false, error: 'No mailbox is associated with this account.', confidence: 0 };
      }

      const daysAhead = Math.min(Math.max(0, params.days_ahead ?? 7), 60);
      const daysBack = Math.min(Math.max(0, params.days_back ?? 0), 30);
      const start = new Date(Date.now() - daysBack * 86400000).toISOString();
      const end = new Date(Date.now() + (daysAhead || 1) * 86400000).toISOString();

      const token = await msGraph.getAppToken();
      const url =
        `${msGraph.GRAPH}/users/${encodeURIComponent(target)}/calendarView` +
        `?startDateTime=${start}&endDateTime=${end}` +
        `&$select=subject,organizer,attendees,start,end,location,isAllDay,isCancelled,onlineMeeting,bodyPreview` +
        `&$orderby=start/dateTime&$top=50`;

      let data;
      try {
        data = await msGraph.graphGet(url, token, { Prefer: 'outlook.timezone="UTC"' });
      } catch (err) {
        if (err.status === 403) {
          return {
            success: false,
            error:
              'Calendar access has not been granted yet. IPS IT needs to add the "Calendars.Read" APPLICATION permission (with admin consent) to the same Entra app used for email.',
            confidence: 0,
          };
        }
        throw err;
      }

      const events = (data.value || [])
        .filter((e) => !e.isCancelled)
        .map((e) => {
          const start = eventTime(e.start, e.isAllDay);
          const end = eventTime(e.end, e.isAllDay);
          return {
            subject: e.subject,
            start_utc: start.utc,
            end_utc: end.utc,
            start_local: start.local,
            end_local: end.local,
            all_day: !!e.isAllDay,
            location: e.location?.displayName || null,
            organizer: e.organizer?.emailAddress?.address || null,
            attendees: (e.attendees || []).slice(0, 15).map((a) => a.emailAddress?.address).filter(Boolean),
            online_meeting_url: e.onlineMeeting?.joinUrl || null,
            preview: String(e.bodyPreview || '').slice(0, 300),
          };
        });

      return {
        success: true,
        data: events,
        summary: `${events.length} calendar event(s) for ${target} (${daysBack}d back → ${daysAhead}d ahead). ` +
          `Quote start_local/end_local as written; each names its own time zone.`,
        confidence: 0.95,
        source_type: 'calendar',
        source_summary: `M365 calendar (live)`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
