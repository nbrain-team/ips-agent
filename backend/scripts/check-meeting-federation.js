#!/usr/bin/env node
/**
 * Live check: can the Ingram master agent find IPS meeting transcripts?
 *
 * The master reaches IPS meetings only through federation: it reads
 * /api/federation/manifest, then calls ips.hybrid_search via
 * /api/federation/tool. This script makes those same calls with the same key,
 * so a pass here means the master's path works end to end, short of the
 * master's own model choosing the tool.
 *
 * For every meeting source (each Zoom account separately, Read.ai, Otter) it
 * samples meetings that have searchable chunks and asks two questions:
 *   1. exact lookup: title + date + a topic → that meeting must be in the results
 *   2. natural question about one of the meeting's topics, no title or date →
 *      that meeting should be in the results (reported, not failed: an older
 *      meeting on a recurring topic can legitimately outrank it)
 *
 * Env: DATABASE_URL (+ DATABASE_SSL), FEDERATION_KEY,
 *      IPS_FEDERATION_URL (default RENDER_EXTERNAL_URL, else the production API),
 *      SAMPLES_PER_SOURCE (default 3).
 * Exit code 1 when the manifest is wrong or any exact lookup misses.
 *
 * Run on the Render shell:  node scripts/check-meeting-federation.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const BASE = (process.env.IPS_FEDERATION_URL || process.env.RENDER_EXTERNAL_URL || 'https://ips-agent-api.onrender.com').replace(/\/+$/, '');
const KEY = process.env.FEDERATION_KEY;
const SAMPLES = parseInt(process.env.SAMPLES_PER_SOURCE || '3', 10);

async function federation(path, body) {
  const resp = await fetch(`${BASE}/api/federation${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Federation-Key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`${path} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function search(query) {
  const r = await federation('/tool', {
    name: 'hybrid_search',
    input: { query, top_k: 10 },
    context: { origin: 'ingram-master', requestId: `meeting-check-${Date.now()}` },
  });
  if (!r.ok) throw new Error(`hybrid_search failed: ${r.error}`);
  return r.result?.data || [];
}

const dateLabel = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

async function main() {
  if (!KEY) throw new Error('FEDERATION_KEY is not set');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  let failures = 0;
  console.log(`Federation endpoint: ${BASE}/api/federation\n`);

  // 1. What the master sees in the manifest
  const manifest = await federation('/manifest');
  const hasTool = (manifest.tools || []).some((t) => t.name === 'hybrid_search');
  const fragmentMentions = /meeting transcripts/i.test(manifest.promptFragment || '');
  const meetingSources = (manifest.dataSources || []).filter((s) => /zoom|meeting/i.test(`${s.label} ${s.detail}`));
  console.log(`Manifest: ${manifest.tools?.length || 0} tools, hybrid_search ${hasTool ? 'present' : 'MISSING'}`);
  console.log(`Prompt fragment routes meeting questions to hybrid_search: ${fragmentMentions ? 'yes' : 'NO'}`);
  for (const s of meetingSources) console.log(`  data source: ${s.label} [${s.status}] ${s.detail}`);
  if (!hasTool || !fragmentMentions) failures++;

  // 2. Sample meetings from every source / account
  const { rows: groups } = await pool.query(
    `SELECT source, COALESCE(source_account, '') AS account, COUNT(*)::int AS n
     FROM meeting_transcripts WHERE chunk_count > 0 GROUP BY 1, 2 ORDER BY 1, 2`
  );
  let exactHits = 0;
  let exactTotal = 0;
  let naturalHits = 0;
  let naturalTotal = 0;
  for (const g of groups) {
    const { rows: meetings } = await pool.query(
      `SELECT session_id, title, meeting_start, topics FROM meeting_transcripts
       WHERE source = $1 AND COALESCE(source_account, '') = $2 AND chunk_count > 0 AND meeting_start IS NOT NULL
       ORDER BY random() LIMIT $3`,
      [g.source, g.account, SAMPLES]
    );
    console.log(`\n${g.source}${g.account ? ` / ${g.account}` : ''} (${g.n} searchable meetings, testing ${meetings.length})`);
    for (const m of meetings) {
      const marker = `readai:${m.session_id}`;
      const topic = (m.topics || [])[0] || '';
      const found = (results) => results.some((r) => r.url === marker);

      const exactQuery = `${m.title} meeting on ${dateLabel(m.meeting_start)}${topic ? ` ${topic}` : ''}`;
      const exact = await search(exactQuery);
      exactTotal++;
      const sameTitle = exact.filter((r) => r.category === 'meeting_transcript' && r.title === m.title).length;
      if (found(exact)) {
        exactHits++;
        console.log(`  PASS exact    "${exactQuery}"`);
      } else {
        failures++;
        console.log(`  FAIL exact    "${exactQuery}" (${sameTitle} same-title chunks returned, not this meeting)`);
      }

      if (topic) {
        const naturalQuery = `What did the team discuss about ${topic}?`;
        const natural = await search(naturalQuery);
        naturalTotal++;
        if (found(natural)) naturalHits++;
        const anyMeeting = natural.filter((r) => r.category === 'meeting_transcript').length;
        console.log(`  ${found(natural) ? 'PASS' : 'MISS'} natural  "${naturalQuery}" (${anyMeeting}/10 results are meeting transcripts)`);
      }
    }
  }

  console.log(`\nExact lookups: ${exactHits}/${exactTotal}. Natural questions: ${naturalHits}/${naturalTotal} returned the sampled meeting.`);
  console.log(failures ? `RESULT: ${failures} failure(s)` : 'RESULT: pass');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Check failed to run:', err.message);
  process.exit(1);
});
