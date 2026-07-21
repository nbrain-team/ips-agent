/**
 * npm run crawl — crawl ipsaecorp.com (same-domain, bounded), strip HTML to
 * text, embed, and store pages in website_content so the agent is
 * brand-consistent from day one (Part 11 pattern 4).
 *
 * Usage: node scripts/crawl-website.js [startUrl] [maxPages]
 */
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { embedText, toVectorLiteral } = require('../agentic/utils/embeddings');

const START_URL = process.argv[2] || 'https://ipsaecorp.com';
const MAX_PAGES = parseInt(process.argv[3] || '40', 10);

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 300) : null;
}

function extractLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const links = new Set();
  const re = /href=["']([^"'#?]+)[^"']*["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const url = new URL(m[1], baseUrl);
      if (url.origin !== origin) continue;
      if (/\.(png|jpe?g|gif|webp|svg|pdf|css|js|ico|woff2?|ttf|xml|zip)$/i.test(url.pathname)) continue;
      if (/\/(wp-json|wp-admin|feed|xmlrpc|wp-content|wp-includes)/.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      links.add(url.href.replace(/\/$/, ''));
    } catch (_e) { /* skip malformed */ }
  }
  return [...links];
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const queue = [START_URL.replace(/\/$/, '')];
  const visited = new Set();
  let saved = 0;

  try {
    while (queue.length && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      let html;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'IPS-AI-Platform-Crawler/1.0' } });
        if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) continue;
        html = await res.text();
      } catch (err) {
        console.warn(`Skip ${url}: ${err.message}`);
        continue;
      }

      for (const link of extractLinks(html, url)) {
        if (!visited.has(link)) queue.push(link);
      }

      const text = htmlToText(html);
      if (text.length < 200) continue;
      const title = extractTitle(html) || url;
      const content = text.slice(0, 20000);
      const hash = crypto.createHash('md5').update(content).digest('hex');

      try {
        const embedding = await embedText(`${title}\n\n${content}`);
        await pool.query(
          `INSERT INTO website_content (url, title, content, category, source, embedding, content_hash)
           VALUES ($1, $2, $3, 'company_information', 'website', $4::vector, $5)
           ON CONFLICT (content_hash) DO NOTHING`,
          [url, title, content, toVectorLiteral(embedding), hash]
        );
        saved++;
        console.log(`✓ ${url} (${content.length} chars)`);
      } catch (err) {
        console.warn(`Failed to save ${url}: ${err.message}`);
      }
    }
    console.log(`\nCrawl complete: ${visited.size} pages visited, ${saved} saved.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
