/**
 * readaiIngest — turns a Read.ai meeting-end webhook payload into agent
 * knowledge: stores the full meeting in meeting_transcripts, then chunks and
 * embeds the transcript into website_content (category 'meeting_transcript')
 * so vector_search / hybrid_search surface it immediately.
 *
 * Idempotent on Read.ai session_id: a re-delivered webhook replaces the
 * meeting's previous chunks instead of duplicating them.
 */
const crypto = require('crypto');
const { embedText, toVectorLiteral } = require('../utils/embeddings');

const CHUNK_CHARS = 2200;

function textOf(list) {
  return (list || [])
    .map((item) => (typeof item === 'string' ? item : item?.text || ''))
    .filter(Boolean);
}

/** Liberal parse of Read.ai's meeting-end payload shape. */
function parsePayload(payload) {
  const p = payload || {};
  const transcriptBlocks = p.transcript?.speaker_blocks || [];
  const transcriptText = transcriptBlocks
    .map((b) => `${b.speaker?.name || 'Speaker'}: ${b.words || ''}`)
    .filter((l) => l.length > 2)
    .join('\n');

  return {
    sessionId: String(p.session_id || p.id || crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 24)),
    source: p.source || 'read.ai',
    trigger: p.trigger || null,
    title: p.title || 'Untitled meeting',
    start: p.start_time || null,
    end: p.end_time || null,
    ownerEmail: (p.owner?.email || '').toLowerCase() || null,
    participants: (p.participants || []).map((x) => ({ name: x.name || null, email: (x.email || '').toLowerCase() || null })),
    summary: p.summary || '',
    actionItems: textOf(p.action_items),
    keyQuestions: textOf(p.key_questions),
    topics: textOf(p.topics),
    reportUrl: p.report_url || null,
    transcriptText,
  };
}

function chunkTranscript(meeting) {
  const dateStr = meeting.start ? new Date(meeting.start).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown date';
  const who = meeting.participants.map((x) => x.name || x.email).filter(Boolean).join(', ');
  const header = `[Meeting: "${meeting.title}" on ${dateStr}${who ? ` — participants: ${who}` : ''}]`;

  const chunks = [];

  // Chunk 0: the overview (summary + action items + topics) — the highest-value
  // retrieval target for "what did we discuss / decide" questions.
  const overviewParts = [header];
  if (meeting.summary) overviewParts.push(`SUMMARY: ${meeting.summary}`);
  if (meeting.actionItems.length) overviewParts.push(`ACTION ITEMS:\n- ${meeting.actionItems.join('\n- ')}`);
  if (meeting.keyQuestions.length) overviewParts.push(`KEY QUESTIONS:\n- ${meeting.keyQuestions.join('\n- ')}`);
  if (meeting.topics.length) overviewParts.push(`TOPICS: ${meeting.topics.join(', ')}`);
  if (overviewParts.length > 1) chunks.push(overviewParts.join('\n\n'));

  // Transcript chunks, split on line boundaries
  const lines = meeting.transcriptText.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length > CHUNK_CHARS && current) {
      chunks.push(`${header}\n\n${current.trim()}`);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(`${header}\n\n${current.trim()}`);

  return chunks;
}

async function ingestMeeting(dbPool, payload) {
  const meeting = parsePayload(payload);

  await dbPool.query(
    `INSERT INTO meeting_transcripts
       (session_id, source, title, meeting_start, meeting_end, owner_email, participants,
        summary, action_items, key_questions, topics, report_url, transcript_text, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (session_id) DO UPDATE SET
       source = EXCLUDED.source,
       title = EXCLUDED.title, meeting_start = EXCLUDED.meeting_start,
       meeting_end = EXCLUDED.meeting_end, owner_email = EXCLUDED.owner_email,
       participants = EXCLUDED.participants, summary = EXCLUDED.summary,
       action_items = EXCLUDED.action_items, key_questions = EXCLUDED.key_questions,
       topics = EXCLUDED.topics, report_url = EXCLUDED.report_url,
       transcript_text = EXCLUDED.transcript_text, raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()`,
    [
      meeting.sessionId, meeting.source, meeting.title, meeting.start, meeting.end, meeting.ownerEmail,
      JSON.stringify(meeting.participants), meeting.summary, JSON.stringify(meeting.actionItems),
      JSON.stringify(meeting.keyQuestions), JSON.stringify(meeting.topics),
      meeting.reportUrl, meeting.transcriptText.slice(0, 2000000), JSON.stringify(payload).slice(0, 2000000),
    ]
  );

  // Replace any previous chunks for this meeting (webhook re-delivery)
  const marker = `readai:${meeting.sessionId}`;
  await dbPool.query(`DELETE FROM website_content WHERE url = $1`, [marker]);

  const chunks = chunkTranscript(meeting);
  let saved = 0;
  for (const chunk of chunks) {
    const hash = crypto.createHash('sha256').update(chunk).digest('hex');
    const embedding = await embedText(chunk);
    await dbPool.query(
      `INSERT INTO website_content (url, title, content, category, source, embedding, content_hash)
       VALUES ($1, $2, $3, 'meeting_transcript', $4, $5::vector, $6)
       ON CONFLICT (content_hash) DO NOTHING`,
      [marker, meeting.title, chunk, meeting.source, toVectorLiteral(embedding), hash]
    );
    saved++;
  }

  await dbPool.query(`UPDATE meeting_transcripts SET chunk_count = $1 WHERE session_id = $2`, [
    saved,
    meeting.sessionId,
  ]);

  console.log(`🎙️ Read.ai ingested: "${meeting.title}" (${meeting.sessionId}) → ${saved} chunks`);
  return { sessionId: meeting.sessionId, title: meeting.title, chunks: saved };
}

module.exports = { ingestMeeting, parsePayload };
