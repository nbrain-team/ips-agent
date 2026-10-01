/**
 * Tabular helpers shared by the NL-to-SQL tools: compact CSV for the model,
 * aggregate detection for the row cap, and numeric column totals.
 */

// pg type OIDs that hold numbers: int8, int2, int4, float4, float8, numeric, money.
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700, 790]);

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace('T00:00:00.000Z', '');
  }
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** One RFC 4180 CSV field, trimmed to maxLen characters. */
function csvCell(value, maxLen = 300) {
  let s = cellText(value);
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header line plus one line per row. Columns come from the first row unless given. */
function toCsv(rows, { columns = null, maxCell = 300 } = {}) {
  if (!rows || rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]);
  const lines = [cols.map((c) => csvCell(c, maxCell)).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c], maxCell)).join(','));
  return lines.join('\n');
}

/** Remove comments and string literals so keywords inside them do not count. */
function stripSqlNoise(sql) {
  return String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const AGG_FN =
  /\b(count|sum|avg|min|max|string_agg|array_agg|json_agg|jsonb_agg|bool_and|bool_or|every|stddev|stddev_pop|stddev_samp|variance|var_pop|var_samp|percentile_cont|percentile_disc|mode)\s*\(/i;

/**
 * True when the statement summarises rather than lists: GROUP BY, SELECT
 * DISTINCT, or an aggregate function. Aggregates written as window functions
 * (SUM(x) OVER (...)) keep one row per source row, so a statement whose only
 * aggregates are windowed is treated as a list.
 */
function isAggregateSQL(sql) {
  const s = stripSqlNoise(sql);
  if (/\bgroup\s+by\b/i.test(s)) return true;
  if (/\bselect\s+distinct\b/i.test(s)) return true;
  if (!AGG_FN.test(s)) return false;
  return !/\bover\s*\(/i.test(s);
}

/** Sum every numeric column. Returns { column: total } for columns that had a number. */
function numericTotals(rows, fields) {
  const numericCols = (fields || []).filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name);
  const totals = {};
  for (const col of numericCols) {
    let sum = 0;
    let seen = false;
    for (const row of rows) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) {
        sum += n;
        seen = true;
      }
    }
    if (seen) totals[col] = Math.round(sum * 100) / 100;
  }
  return totals;
}

module.exports = { NUMERIC_OIDS, csvCell, toCsv, isAggregateSQL, numericTotals, stripSqlNoise };
