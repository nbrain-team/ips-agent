/**
 * search_user_emails — search synced Microsoft 365 email with hard
 * permission scoping enforced in SQL:
 *   - regular users: ONLY their own mailbox (session email = mailbox_email)
 *   - admins: any/all mailboxes
 * The ms_emails table is excluded from the generic NL-to-SQL layer, so this
 * tool is the ONLY way the agent can touch email.
 *
 * RANKED SEARCH
 * -------------
 * plainto_tsquery ANDs every word, so each keyword the model added narrowed
 * the search until nothing matched: "RFP RFQ invitation to bid ITB electrical
 * powerline fiber automation" found 0 emails in mailboxes holding hundreds of
 * bid invitations. Words are now weighted by rarity (sampled from the mailboxes
 * being searched) and results ranked by how much of the query each email
 * carries, so more words can only add matches. Words in a large share of the
 * mail — "powerline" sits in a fifth of IPS email via signatures — still count
 * toward rank but cannot pull candidates on their own, because an OR over them
 * matched 80% of a mailbox and took 15s.
 *
 * WHAT THE MODEL SEES
 * -------------------
 * The orchestrator passes the model `formatted || data`, never `summary`. An
 * empty search used to reach it as a bare [], indistinguishable from denied
 * access, and it told an admin nine times that she lacked permission. The
 * model-facing payload therefore always states which mailboxes were searched,
 * how much mail they hold, and how names in `mailbox` were resolved.
 */

const SAMPLE_SIZE = 3000;
const MIN_SAMPLE_FOR_COMMON = 200;
const COMMON_SHARE = 0.1;
const MAX_INFORMATIVE_TERMS = 10;
const MAX_IDENTIFIER_TERMS = 3;
const CANDIDATE_CAP = 3000;
const ANY_TIER_TIMEOUT_MS = 6000;
const AUX_TIMEOUT_MS = 4000;
const MAX_LIMIT = 50;
const SUBJECT_BOOST = 2;
const SELF_WORDS = new Set(['me', 'my', 'mine', 'myself', 'my mailbox', 'my inbox']);
const QUERY_OPERATORS = new Set(['or', 'and', 'not']);

/** Runs one statement under its own timeout; null when it timed out. */
async function timedQuery(db, sql, args, ms) {
  if (typeof db.connect !== 'function') return db.query(sql, args);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(500, parseInt(ms, 10))}`);
    const result = await client.query(sql, args);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '57014') return null;
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** Quoted phrases stay together; everything else becomes individual words. */
function splitQuery(raw) {
  const terms = [];
  const seen = new Set();
  const add = (text, phrase) => {
    const clean = text.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    terms.push({ text: clean, phrase });
  };
  const rest = String(raw || '').replace(/"([^"]+)"/g, (_m, p) => {
    add(p, true);
    return ' ';
  });
  for (const token of rest.split(/[\s,;]+/)) {
    const word = token.replace(/^[^\w@#]+|[^\w]+$/g, '');
    if (word && !QUERY_OPERATORS.has(word.toLowerCase())) add(word, false);
  }
  return terms;
}

/** Postgres turns each term into its own tsquery; stopword-only terms drop out. */
async function compileTerms(db, terms) {
  if (!terms.length) return [];
  const { rows } = await db.query(
    `SELECT t.ord::int AS ord,
            (CASE WHEN t.phrase THEN phraseto_tsquery('english', t.txt)
                  ELSE plainto_tsquery('english', t.txt) END)::text AS q
       FROM unnest($1::text[], $2::bool[]) WITH ORDINALITY AS t(txt, phrase, ord)`,
    [terms.map((t) => t.text), terms.map((t) => t.phrase)]
  );
  const seenQ = new Set();
  const compiled = [];
  for (const row of rows.sort((a, b) => a.ord - b.ord)) {
    const term = terms[row.ord - 1];
    if (!row.q || seenQ.has(row.q)) continue;
    seenQ.add(row.q);
    compiled.push({
      text: term.text,
      q: row.q,
      // Ticket and PO numbers, which the English parser splits apart.
      identifier: !term.phrase && /[^A-Za-z]/.test(term.text) && /\d/.test(term.text),
    });
  }
  return compiled;
}

const orQuery = (terms) => terms.map((t) => `(${t.q})`).join(' | ');

/** Matches any email containing at least two of the terms. */
function pairQuery(terms) {
  const pairs = [];
  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) pairs.push(`((${terms[i].q}) & (${terms[j].q}))`);
  }
  return pairs.join(' | ');
}

// ---------------------------------------------------------------------------
// Mailbox resolution
// ---------------------------------------------------------------------------

const localPart = (email) => email.split('@')[0];
const personKey = (mb) => (mb.display_name || mb.email).trim().toLowerCase();

/**
 * Accepts addresses, names ("elgin", "Ryan Gray"), lists of either, and
 * near-miss addresses ("e.moreno@ipseacorp.com"). One person can own several
 * addresses (.com and .org), and all of them are searched.
 */
async function resolveMailboxes(db, raw, ownEmail) {
  const tokens = (Array.isArray(raw) ? raw : String(raw).split(/[,;\n]|\s+and\s+|\s*&\s*/i))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);

  const { rows: all } = await db.query(
    `SELECT LOWER(email) AS email, display_name, sync_status FROM ms_mailboxes WHERE account_enabled = true`
  );
  const synced = all.filter((m) => m.sync_status === 'ok');
  const pool = synced.length ? synced : all;

  const addresses = new Set();
  const notes = [];
  const unresolved = [];

  const byPerson = (matches) => {
    const people = new Map();
    for (const m of matches) {
      const key = personKey(m);
      if (!people.has(key)) people.set(key, { name: m.display_name || m.email, emails: [] });
      people.get(key).emails.push(m.email);
    }
    return [...people.values()];
  };
  const describe = (people) => people.map((p) => `${p.name} (${p.emails.join(', ')})`).join('; ');

  for (const token of tokens) {
    if (SELF_WORDS.has(token)) {
      if (ownEmail) addresses.add(ownEmail);
      continue;
    }

    let matches = [];
    let guessed = false;
    if (token.includes('@')) {
      matches = all.filter((m) => m.email === token);
      if (!matches.length) {
        matches = pool.filter((m) => localPart(m.email) === localPart(token));
        guessed = true;
      }
    } else {
      matches = pool.filter((m) => localPart(m.email) === token);
      if (!matches.length) {
        const words = token.split(/\s+/);
        matches = pool.filter((m) => {
          const name = (m.display_name || '').toLowerCase();
          return words.every((w) => name.split(/[^a-z0-9']+/).some((part) => part.startsWith(w)));
        });
      }
      guessed = true;
    }

    const people = byPerson(matches);
    if (people.length === 1) {
      people[0].emails.forEach((e) => addresses.add(e));
      if (guessed) notes.push(`"${token}" resolved to ${describe(people)}.`);
    } else if (people.length > 1) {
      unresolved.push(token);
      notes.push(
        `"${token}" matches ${people.length} people and was NOT searched: ${describe(people)}. ` +
          'Use context to pick one and search again with that address, or ask the user.'
      );
    } else {
      unresolved.push(token);
      notes.push(`"${token}" does not match any synced mailbox and was NOT searched.`);
    }
  }

  return { addresses: [...addresses], notes, unresolved };
}

// ---------------------------------------------------------------------------
// SQL scope
// ---------------------------------------------------------------------------

function buildScope({ mailboxes, sinceDays, from }) {
  const args = [];
  const where = [];
  if (mailboxes) {
    args.push(mailboxes);
    where.push(`e.mailbox_email = ANY($${args.length}::text[])`);
  }
  args.push(String(sinceDays));
  where.push(`e.received_at > NOW() - ($${args.length} || ' days')::interval`);
  if (from) {
    args.push(`%${from.toLowerCase()}%`);
    where.push(`(LOWER(e.from_address) LIKE $${args.length} OR LOWER(e.from_name) LIKE $${args.length})`);
  }
  return { where: where.join(' AND '), args };
}

const ATTACHMENT_TSV = `to_tsvector('english', COALESCE(a.filename, '') || ' ' || COALESCE(a.text_content, ''))`;

/** Message ids (newest first) whose body, subject or attachments match `tsq`. */
async function findCandidates(db, scope, tsq, identifiers, timeoutMs) {
  const args = [...scope.args, tsq];
  const q = `$${args.length}::tsquery`;
  const branches = [
    `SELECT e.ms_message_id, e.received_at FROM ms_emails e
      WHERE ${scope.where} AND e.fts @@ ${q}
      ORDER BY e.received_at DESC LIMIT ${CANDIDATE_CAP}`,
    `SELECT e.ms_message_id, e.received_at FROM ms_email_attachments a
       JOIN ms_emails e ON e.ms_message_id = a.ms_message_id
      WHERE ${scope.where} AND ${ATTACHMENT_TSV} @@ ${q}
      ORDER BY e.received_at DESC LIMIT ${CANDIDATE_CAP}`,
  ];
  for (const ident of identifiers) {
    args.push(ident.text);
    branches.push(
      `SELECT e.ms_message_id, e.received_at FROM ms_emails e
        WHERE ${scope.where} AND e.subject ILIKE '%' || $${args.length} || '%'
        ORDER BY e.received_at DESC LIMIT ${CANDIDATE_CAP}`
    );
  }
  const sql = branches.map((b) => `(${b})`).join(' UNION ');
  const result = timeoutMs ? await timedQuery(db, sql, args, timeoutMs) : await db.query(sql, args);
  return result ? result.rows : null;
}

/** Share of recent in-scope mail carrying each term, and the sample size. */
async function sampleTermShares(db, scope, terms) {
  const args = [...scope.args, terms.map((t) => t.q)];
  const { rows } = await db.query(
    `WITH s AS (
       SELECT e.fts FROM ms_emails e WHERE ${scope.where}
       ORDER BY e.received_at DESC LIMIT ${SAMPLE_SIZE}
     )
     SELECT t.i::int AS i, COUNT(s.fts) FILTER (WHERE s.fts @@ t.q)::int AS hits,
            (SELECT COUNT(*) FROM s)::int AS n
       FROM unnest($${args.length}::tsquery[]) WITH ORDINALITY AS t(q, i)
       LEFT JOIN s ON true
      GROUP BY t.i`,
    args
  );
  const n = rows.length ? rows[0].n : 0;
  const hits = new Array(terms.length).fill(0);
  for (const r of rows) hits[r.i - 1] = r.hits;
  return { n, hits };
}

async function countInScope(db, scope) {
  const result = await timedQuery(
    db,
    `SELECT COUNT(*)::int AS n, MAX(e.received_at) AS newest FROM ms_emails e WHERE ${scope.where}`,
    scope.args,
    AUX_TIMEOUT_MS
  ).catch(() => null);
  return result ? result.rows[0] : { n: null, newest: null };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

module.exports = {
  name: 'search_user_emails',
  description: `Search the user's synced Microsoft 365 email. Returns subject, sender, recipients, date, body text, and extracted attachment text (PDFs, Word, Excel).

WHEN TO USE: any question about emails — "find the email from X", "what did Y say about the bid?", "summarize my emails today", "any emails about the Chevron job?", "roll up the bid invitations Ryan, Elgin and Victor received".

QUERY: use as many words as help. Results are ranked by how many of the words each email contains (rare words count more), so extra words never hide matches. Put exact phrases in double quotes ("invitation to bid"). Each result lists the words it matched.

MAILBOX: an address, a person's name ("Elgin", "Ryan Gray"), or several separated by commas. Names and near-miss addresses are resolved to the right mailboxes; the result says how. If a name matches several people the result lists them so you can pick.

PERMISSIONS (enforced automatically — do not try to work around them):
- Regular users can ONLY see their own mailbox.
- Admins can search all mailboxes, or specific people via "mailbox".
- A permission problem always comes back as an error. A successful result with no emails is never an access problem: read "searched" in the result, which says how much mail was searched.`,
  category: 'email',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Words and "quoted phrases" to search subject, sender, body and attachments. Any number of words. Omit to list recent emails.',
      },
      from_address: {
        type: 'string',
        description: 'Optional: only emails from this sender (address, partial address or name).',
      },
      since_days: {
        type: 'number',
        description: 'Look-back window in days (default 30, max 365 — everything ever synced stays searchable).',
      },
      mailbox: {
        type: 'string',
        description: "ADMIN ONLY: whose mailbox(es) to search — addresses or names, comma-separated. Omit to search all mailboxes (admin) or your own (regular user).",
      },
      limit: {
        type: 'number',
        description: `Max results (default 15, max ${MAX_LIMIT}).`,
      },
      offset: {
        type: 'number',
        description: 'Skip this many ranked results, to page through a long result set (see has_more).',
      },
    },
    required: [],
  },
  async execute(params, context) {
    try {
      const db = context.dbPool;
      const isAdmin = context.userRole === 'admin';
      const ownEmail = (context.userEmail || '').toLowerCase();

      if (!isAdmin && !ownEmail) {
        return { success: false, error: 'No mailbox is associated with this account.', confidence: 0 };
      }

      // Visibility scope — the load-bearing block
      let mailboxes = null;
      let mailboxNotes = [];
      const mailboxParam = Array.isArray(params.mailbox) ? params.mailbox.join(',') : String(params.mailbox || '').trim();
      if (mailboxParam) {
        const resolved = await resolveMailboxes(db, mailboxParam, ownEmail);
        mailboxNotes = resolved.notes;
        if (!isAdmin && resolved.addresses.some((a) => a !== ownEmail)) {
          return {
            success: false,
            error: 'Permission denied: only admins can search other people\'s mailboxes.',
            confidence: 0,
          };
        }
        if (!resolved.addresses.length) {
          return {
            success: false,
            error: `No mailbox searched. ${resolved.notes.join(' ')}`,
            confidence: 0,
          };
        }
        mailboxes = resolved.addresses;
      } else if (!isAdmin) {
        mailboxes = [ownEmail];
      }

      const sinceDays = Math.min(Math.max(1, parseInt(params.since_days, 10) || 30), 365);
      const limit = Math.min(Math.max(1, parseInt(params.limit, 10) || 15), MAX_LIMIT);
      const offset = Math.max(0, parseInt(params.offset, 10) || 0);
      const scope = buildScope({ mailboxes, sinceDays, from: params.from_address });
      const scopeLabel = mailboxes ? mailboxes.join(', ') : 'all mailboxes';

      const terms = await compileTerms(db, splitQuery(params.query));
      let ordered;
      let matching = null;

      if (!terms.length) {
        const { rows } = await db.query(
          `SELECT e.ms_message_id FROM ms_emails e WHERE ${scope.where}
           ORDER BY e.received_at DESC LIMIT ${offset + limit + 1}`,
          scope.args
        );
        ordered = rows.map((r) => ({ id: r.ms_message_id, hits: [] }));
      } else {
        // Rarity weights. A small scope gives an unreliable sample, so nothing
        // is treated as common there.
        const { n, hits } = await sampleTermShares(db, scope, terms);
        terms.forEach((t, i) => {
          t.share = n ? hits[i] / n : 0;
          t.weight = Math.log((n + 1) / (hits[i] + 0.5));
        });
        let informative = terms.filter((t) => n < MIN_SAMPLE_FOR_COMMON || t.share <= COMMON_SHARE);
        if (!informative.length) informative = [...terms];
        informative = informative.sort((a, b) => a.share - b.share).slice(0, MAX_INFORMATIVE_TERMS);
        const common = terms.filter((t) => !informative.includes(t));
        const identifiers = terms.filter((t) => t.identifier).slice(0, MAX_IDENTIFIER_TERMS);
        matching = { informative, common };

        const candidates = new Map();
        const collect = (rows) => rows && rows.forEach((r) => candidates.set(r.ms_message_id, r.received_at));

        if (n > 0) {
          const firstTier = informative.length >= 2 ? pairQuery(informative) : informative[0].q;
          collect(await findCandidates(db, scope, firstTier, identifiers));
          if (candidates.size < offset + limit && informative.length >= 2) {
            let rows = await findCandidates(db, scope, orQuery(informative), [], ANY_TIER_TIMEOUT_MS);
            if (!rows) {
              const rarest = informative.slice(0, Math.max(1, Math.ceil(informative.length / 2)));
              rows = await findCandidates(db, scope, orQuery(rarest), [], ANY_TIER_TIMEOUT_MS);
            }
            collect(rows);
          }
        }

        const ids = [...candidates.keys()];
        const scored = new Map();
        if (ids.length) {
          const { rows } = await db.query(
            `SELECT e.ms_message_id, e.received_at, e.mailbox_email, e.subject, e.from_address,
                    ARRAY(SELECT t.i::int FROM unnest($2::tsquery[], $3::text[]) WITH ORDINALITY AS t(q, raw, i)
                           WHERE e.fts @@ t.q OR (t.raw <> '' AND e.subject ILIKE '%' || t.raw || '%')) AS hits,
                    ARRAY(SELECT t.i::int FROM unnest($2::tsquery[]) WITH ORDINALITY AS t(q, i)
                           WHERE to_tsvector('english', COALESCE(e.subject, '')) @@ t.q) AS subject_hits,
                    ts_rank_cd(e.fts, $4::tsquery) AS rank
               FROM ms_emails e WHERE e.ms_message_id = ANY($1::text[])`,
            [ids, terms.map((t) => t.q), terms.map((t) => (t.identifier ? t.text : '')), orQuery(terms)]
          );
          rows.forEach((r) =>
            scored.set(r.ms_message_id, {
              id: r.ms_message_id,
              received: r.received_at,
              mailbox: r.mailbox_email,
              copyKey: `${String(r.subject || '').trim().toLowerCase()}|${r.from_address}|${new Date(r.received_at).toISOString()}`,
              rank: Number(r.rank) || 0,
              hits: new Set(r.hits),
              subjectHits: new Set(r.subject_hits),
            })
          );

          // Driven from the attachment index term by term. Joining on the
          // candidate ids instead recomputed to_tsvector over every candidate
          // attachment and ran out its timeout on any real roll-up.
          const att = await timedQuery(
            db,
            `WITH m AS MATERIALIZED (
               SELECT a.ms_message_id, t.i::int AS i
                 FROM unnest($2::tsquery[]) WITH ORDINALITY AS t(q, i)
                 JOIN LATERAL (SELECT a.ms_message_id FROM ms_email_attachments a WHERE ${ATTACHMENT_TSV} @@ t.q) a ON true
             )
             SELECT DISTINCT ms_message_id, i FROM m WHERE ms_message_id = ANY($1::text[])`,
            [ids, terms.map((t) => t.q)],
            AUX_TIMEOUT_MS
          ).catch(() => null);
          if (att) att.rows.forEach((r) => scored.get(r.ms_message_id)?.hits.add(r.i));
        }

        const ranked = [...scored.values()]
          // A word in the subject says what the email is about; the same word
          // in a 40-page attached MSA mostly says the document is long.
          .map((s) => ({
            ...s,
            score: [...s.hits].reduce((sum, i) => sum + terms[i - 1].weight * (s.subjectHits.has(i) ? SUBJECT_BOOST : 1), 0),
          }))
          .filter((s) => s.hits.size > 0)
          .sort((a, b) => b.score - a.score || b.rank - a.rank || new Date(b.received) - new Date(a.received));

        // One email sent to three estimators is three rows, one per mailbox.
        // A roll-up wants it once, with everyone who received it.
        const copies = new Map();
        ordered = [];
        for (const s of ranked) {
          const seen = copies.get(s.copyKey);
          if (seen) {
            if (!seen.mailboxes.includes(s.mailbox)) seen.mailboxes.push(s.mailbox);
            continue;
          }
          const entry = { id: s.id, mailboxes: [s.mailbox], hits: [...s.hits].sort((a, b) => a - b).map((i) => terms[i - 1].text) };
          copies.set(s.copyKey, entry);
          ordered.push(entry);
        }
      }

      const page = ordered.slice(offset, offset + limit);
      const hasMore = ordered.length > offset + limit;
      const pageById = new Map(page.map((p) => [p.id, p]));

      let rows = [];
      if (page.length) {
        const result = await db.query(
          `SELECT e.ms_message_id, e.mailbox_email, e.subject, e.from_name, e.from_address, e.to_addresses,
                  e.received_at, e.has_attachments, e.body_text, e.web_link
             FROM ms_emails e WHERE e.ms_message_id = ANY($1::text[])`,
          [page.map((p) => p.id)]
        );
        const byId = new Map(result.rows.map((r) => [r.ms_message_id, r]));
        rows = page.map((p) => byId.get(p.id)).filter(Boolean);
      }

      // Pull extracted attachment text for the returned messages (best-effort)
      const attachmentsByMessage = {};
      const withAttachments = rows.filter((r) => r.has_attachments).map((r) => r.ms_message_id);
      if (withAttachments.length) {
        try {
          const att = await db.query(
            `SELECT ms_message_id, filename, text_content FROM ms_email_attachments
             WHERE ms_message_id = ANY($1) AND text_content IS NOT NULL`,
            [withAttachments]
          );
          for (const a of att.rows) {
            (attachmentsByMessage[a.ms_message_id] ||= []).push({
              filename: a.filename,
              text: String(a.text_content || '').slice(0, 3000),
            });
          }
        } catch (_e) { /* table may not exist yet */ }
      }

      const data = rows.map((r) => ({
        mailbox: r.mailbox_email,
        subject: r.subject,
        from: r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address,
        to: (r.to_addresses || []).join(', '),
        received: r.received_at,
        ...((pageById.get(r.ms_message_id).mailboxes || []).length > 1
          ? { also_in: pageById.get(r.ms_message_id).mailboxes.filter((m) => m !== r.mailbox_email) }
          : {}),
        ...(terms.length ? { matched_terms: pageById.get(r.ms_message_id).hits } : {}),
        attachments: r.has_attachments,
        attachment_contents: attachmentsByMessage[r.ms_message_id] || undefined,
        body: String(r.body_text || '').slice(0, 1500),
        link: r.web_link,
      }));

      // The hourly sync can fail for days without anything downstream noticing:
      // from Sep 27 an expired Graph secret froze every mailbox, and answers
      // about "this week" quietly stopped at the 27th. Say so in the result.
      let syncWarning;
      try {
        const fresh = await db.query('SELECT MAX(received_at) AS newest FROM ms_emails');
        const newest = fresh.rows[0] && fresh.rows[0].newest;
        if (newest && Date.now() - new Date(newest).getTime() > 12 * 3600 * 1000) {
          syncWarning =
            `Mail sync is behind: the newest message in ANY synced mailbox is from ${new Date(newest).toISOString()}. ` +
            'Nothing after that is searchable — tell the user their answer stops at that date.';
        }
      } catch (_e) { /* best-effort */ }

      const searched = {
        access: isAdmin ? 'admin — every synced mailbox is visible' : `own mailbox only (${ownEmail})`,
        mailboxes: scopeLabel,
        window: `last ${sinceDays} days`,
        ...(params.from_address ? { from: params.from_address } : {}),
      };
      if (matching) {
        searched.ranked_by = matching.informative.map((t) => t.text);
        if (matching.common.length) {
          searched.too_common_to_match_on_alone = matching.common.map((t) => t.text);
        }
      }

      let explanation;
      if (!data.length && offset > 0 && ordered.length) {
        explanation = `No more results: all ${ordered.length} matches were on earlier pages (offset below ${offset}).`;
      } else if (!data.length) {
        const volume = await countInScope(db, scope);
        searched.emails_in_scope = volume.n;
        if (volume.n === 0) {
          explanation =
            `No email at all in ${scopeLabel} for the last ${sinceDays} days` +
            `${params.from_address ? ` from "${params.from_address}"` : ''}. Widen since_days or drop the sender filter.`;
        } else {
          const specific = matching ? matching.informative.map((t) => `"${t.text}"`).join(', ') : '';
          const common = matching && matching.common.length ? matching.common.map((t) => `"${t.text}"`).join(', ') : '';
          explanation =
            `This is NOT an access problem: ${scopeLabel} holds ${volume.n ?? 'many'} emails in this window and all were searched. ` +
            `None contain ${specific}` +
            (common ? ` (${common}: too common in this mail to find results on their own, used only for ranking)` : '') +
            '. Try different words (synonyms, project or customer names, sender names) or a longer since_days.';
        }
      }

      const notes = [...mailboxNotes, ...(syncWarning ? [syncWarning] : []), ...(explanation ? [explanation] : [])];
      const summary =
        `${data.length} email(s) found in ${scopeLabel}${hasMore ? ' (more available)' : ''}` +
        (notes.length ? `. ${notes.join(' ')}` : '');

      return {
        success: true,
        data,
        formatted: {
          searched,
          ...(notes.length ? { notes } : {}),
          result_count: data.length,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + limit } : {}),
          emails: data,
        },
        ...(syncWarning ? { sync_warning: syncWarning } : {}),
        summary,
        confidence: data.length ? 0.9 : 0.6,
        source_type: 'email',
        source_summary: `M365 mail search (${sinceDays}d window)`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
