/**
 * search_user_emails — search synced Microsoft 365 email with hard
 * permission scoping enforced in SQL:
 *   - regular users: ONLY their own mailbox (session email = mailbox_email)
 *   - admins: any/all mailboxes
 * The ms_emails table is excluded from the generic NL-to-SQL layer, so this
 * tool is the ONLY way the agent can touch email.
 */

module.exports = {
  name: 'search_user_emails',
  description: `Search the user's synced Microsoft 365 email (last ~30 days). Returns subject, sender, recipients, date, and body text.

WHEN TO USE: any question about emails — "find the email from X", "what did Y say about the bid?", "summarize my emails today", "any emails about the Chevron job?".

PERMISSIONS (enforced automatically — do not try to work around them):
- Regular users can ONLY see their own mailbox.
- Admins can search all mailboxes, or one specific mailbox via the "mailbox" parameter.
If a non-admin asks about someone else's email, explain that only admins can do that.`,
  category: 'email',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search subject/sender/body. Omit to list recent emails.',
      },
      from_address: {
        type: 'string',
        description: 'Optional: only emails from this sender address (or partial match).',
      },
      since_days: {
        type: 'number',
        description: 'Look-back window in days (default 30, max 30).',
      },
      mailbox: {
        type: 'string',
        description: "ADMIN ONLY: search a specific person's mailbox (their email address). Omit to search all mailboxes (admin) or your own (regular user).",
      },
      limit: {
        type: 'number',
        description: 'Max results (default 15, max 50).',
      },
    },
    required: [],
  },
  async execute(params, context) {
    try {
      const isAdmin = context.userRole === 'admin';
      const ownEmail = (context.userEmail || '').toLowerCase();

      if (!isAdmin && !ownEmail) {
        return { success: false, error: 'No mailbox is associated with this account.', confidence: 0 };
      }
      if (!isAdmin && params.mailbox && params.mailbox.toLowerCase() !== ownEmail) {
        return {
          success: false,
          error: 'Permission denied: only admins can search other people\'s mailboxes.',
          confidence: 0,
        };
      }

      const where = [];
      const args = [];

      // Visibility scope — the load-bearing line
      if (!isAdmin) {
        args.push(ownEmail);
        where.push(`mailbox_email = $${args.length}`);
      } else if (params.mailbox) {
        args.push(params.mailbox.toLowerCase());
        where.push(`mailbox_email = $${args.length}`);
      }

      const sinceDays = Math.min(Math.max(1, params.since_days || 30), 30);
      args.push(String(sinceDays));
      where.push(`received_at > NOW() - ($${args.length} || ' days')::interval`);

      if (params.from_address) {
        args.push(`%${params.from_address.toLowerCase()}%`);
        where.push(`from_address LIKE $${args.length}`);
      }

      let rankSelect = '0 AS rank';
      if (params.query && params.query.trim()) {
        args.push(params.query.trim());
        rankSelect = `ts_rank(fts, plainto_tsquery('english', $${args.length})) AS rank`;
        where.push(
          `(fts @@ plainto_tsquery('english', $${args.length}) OR subject ILIKE '%' || $${args.length} || '%')`
        );
      }

      const limit = Math.min(Math.max(1, params.limit || 15), 50);
      args.push(limit);

      const sql = `
        SELECT mailbox_email, subject, from_name, from_address, to_addresses,
               received_at, has_attachments, body_text, web_link, ${rankSelect}
        FROM ms_emails
        WHERE ${where.join(' AND ')}
        ORDER BY ${params.query ? 'rank DESC,' : ''} received_at DESC
        LIMIT $${args.length}`;

      const result = await context.dbPool.query(sql, args);
      const rows = result.rows.map((r) => ({
        mailbox: r.mailbox_email,
        subject: r.subject,
        from: r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address,
        to: (r.to_addresses || []).join(', '),
        received: r.received_at,
        attachments: r.has_attachments,
        body: String(r.body_text || '').slice(0, 1500),
        link: r.web_link,
      }));

      return {
        success: true,
        data: rows,
        summary: `${rows.length} email(s) found${!isAdmin ? ` in ${ownEmail}` : params.mailbox ? ` in ${params.mailbox}` : ' across all mailboxes'}`,
        confidence: rows.length ? 0.9 : 0.4,
        source_type: 'email',
        source_summary: `M365 mail search (${sinceDays}d window)`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
