/**
 * Ramp — IPS corporate spend (cards, transactions, bills, reimbursement trips,
 * vendors, spend limits, accounting mappings) synced into the `ramp` schema.
 *
 * Tables are created on first sight from the API's own records, so the
 * operational-database tool discovers them like any other table once they are
 * profiled; the master brain reaches them through ips.query_operational_database.
 *
 * Auth is a Ramp developer app (client credentials) created by IPS in its own
 * Ramp account. Ramp expires client-credential tokens after 10 days and issues
 * no refresh token, so a fresh one is minted every run — a pasted token is what
 * silently broke the previous Ramp connection in February.
 *
 * Studio Golf has a separate Ramp account (Rachel, Sep 22) whose data must
 * never land here, so the key's business name is checked before any write.
 */

const SchemaDetector = require('./rampSchemaDetector');

const SCHEMA = 'ramp';

const RAMP_READ_SCOPES = [
  'business:read',
  'cards:read',
  'bills:read',
  'transactions:read',
  'transfers:read',
  'trips:read',
  'users:read',
  'vendors:read',
  'limits:read',
  'accounting:read',
  'custom_records:read',
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isConfigured() {
  return Boolean(process.env.RAMP_CLIENT_ID && process.env.RAMP_CLIENT_SECRET);
}

class RampSync {
  constructor(pool) {
    if (!isConfigured()) throw new Error('Ramp not configured (RAMP_CLIENT_ID / RAMP_CLIENT_SECRET)');
    this.pool = pool;
    this.schema = SCHEMA;
    this.label = 'IPS';
    // Studio Golf has its own Ramp account; a key for any other business is refused.
    this.expectedBusiness = process.env.RAMP_EXPECTED_BUSINESS || 'Ingram Professional';
    this.baseUrl = (process.env.RAMP_BASE_URL || 'https://api.ramp.com').replace(/\/+$/, '');
    this.clientId = process.env.RAMP_CLIENT_ID;
    this.clientSecret = process.env.RAMP_CLIENT_SECRET;
    this.token = null;
    this.timeout = parseInt(process.env.RAMP_TIMEOUT || '45000');
    this.sleepBetweenCalls = parseFloat(process.env.RAMP_SLEEP || '0.12') * 1000;
    this.sleepBetweenInfoCalls = parseFloat(process.env.RAMP_INFO_SLEEP || '0.25') * 1000;
    this.maxPages = parseInt(process.env.RAMP_MAX_PAGES || '4000');
    this.pageSize = Math.min(100, parseInt(process.env.RAMP_PAGE_SIZE || '100'));
    this.maxRecords = parseInt(process.env.RAMP_LIST_MAX_RECORDS || '0');
    this.pullInfo = (process.env.RAMP_PULL_INFO || '1').trim() === '1';
    this.txInfoMaxIds = parseInt(process.env.RAMP_TRANSACTIONS_INFO_MAX_IDS || '1000');
    this.infoMaxIds = parseInt(process.env.RAMP_INFO_MAX_IDS || '0');

    this.disabledEndpoints = new Set();

    // ── List endpoints ──
    this.listEndpoints = [
      { name: 'cards',           path: '/developer/v1/cards' },
      { name: 'bills',           path: '/developer/v1/bills' },
      { name: 'transactions',    path: '/developer/v1/transactions' },
      { name: 'transfers',       path: '/developer/v1/transfers' },
      { name: 'trips',           path: '/developer/v1/trips' },
      { name: 'users',           path: '/developer/v1/users' },
      { name: 'vendors',         path: '/developer/v1/vendors' },
      { name: 'vendor_credits',  path: '/developer/v1/vendors/credits' },
      { name: 'limits',          path: '/developer/v1/limits' },
      { name: 'matrix_tables',   path: '/developer/v1/custom-records/matrix-tables' },
      { name: 'accounting_gl_accounts',             path: '/developer/v1/accounting/accounts' },
      { name: 'accounting_fields',                   path: '/developer/v1/accounting/fields' },
      { name: 'accounting_tax_rates',                path: '/developer/v1/accounting/tax/rates' },
      { name: 'accounting_vendors',                  path: '/developer/v1/accounting/vendors' },
      { name: 'accounting_inventory_item_options',   path: '/developer/v1/accounting/inventory-item/options' },
      { name: 'accounting_tax_code_options',         path: '/developer/v1/accounting/tax/code/options' },
    ];

    // ── Singleton endpoints ──
    this.singletonEndpoints = [
      { name: 'business',                   path: '/developer/v1/business' },
      { name: 'business_balance',            path: '/developer/v1/business/balance' },
      { name: 'accounting_all_connections',  path: '/developer/v1/accounting/all-connections' },
    ];

    // ── Info (detail-by-ID) endpoints ──
    this.infoEndpoints = {
      bills_info:            { pathTpl: '/developer/v1/bills/{id}',            parentList: 'bills',           idKeys: ['id', 'bill_id'] },
      transactions_info:     { pathTpl: '/developer/v1/transactions/{id}',     parentList: 'transactions',    idKeys: ['id', 'transaction_id'] },
      transfers_info:        { pathTpl: '/developer/v1/transfers/{id}',        parentList: 'transfers',       idKeys: ['id', 'transfer_id'] },
      trips_info:            { pathTpl: '/developer/v1/trips/{id}',            parentList: 'trips',           idKeys: ['id', 'trip_id'] },
      users_info:            { pathTpl: '/developer/v1/users/{id}',            parentList: 'users',           idKeys: ['id', 'user_id'] },
      vendors_credits_info:  { pathTpl: '/developer/v1/vendors/credits/{id}',  parentList: 'vendor_credits',  idKeys: ['id', 'vendor_credit_id'] },
      limits_info:           { pathTpl: '/developer/v1/limits/{id}',           parentList: 'limits',          idKeys: ['id', 'spend_limit_id'] },
    };

    this.collectedIds = {};
  }

  // ────────────────────────────────────────────────────────────
  // HTTP helpers
  // ────────────────────────────────────────────────────────────

  async fetchJson(url, init) {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeout) });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_e) {
      data = text;
    }
    return { status: resp.status, data, headers: Object.fromEntries(resp.headers.entries()) };
  }

  requestToken(scopes) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    return this.fetchJson(this.buildUrl('/developer/v1/token'), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }).toString(),
    });
  }

  // Ramp rejects the whole token request if it names a scope the app was not
  // given, so each read scope is probed on its own and only the granted ones
  // are requested together.
  async authenticate() {
    const granted = [];
    for (const scope of RAMP_READ_SCOPES) {
      const resp = await this.requestToken([scope]);
      if (resp.status === 200) {
        granted.push(scope);
        continue;
      }
      // A scope the app lacks is expected; anything else (a malformed or
      // revoked client ID/secret comes back as a 400) means no scope will work.
      const message = resp.data?.error?.message || resp.data?.error_description || resp.data?.error || '';
      if (!/scope/i.test(JSON.stringify(message))) {
        throw new Error(`Ramp rejected the client ID/secret (HTTP ${resp.status}): ${JSON.stringify(message)}`);
      }
    }
    if (granted.length === 0) {
      throw new Error('Ramp app has none of the read scopes enabled');
    }
    const resp = await this.requestToken(granted);
    if (resp.status !== 200 || !resp.data?.access_token) {
      throw new Error(`Ramp token request failed: HTTP ${resp.status} ${JSON.stringify(resp.data)}`);
    }
    this.token = resp.data.access_token;
    this.grantedScopes = granted;
    const missing = RAMP_READ_SCOPES.filter((s) => !granted.includes(s));
    console.log(`[Ramp] Token minted with ${granted.length} scopes: ${granted.join(' ')}`);
    if (missing.length) console.log(`[Ramp] Scopes not enabled on the app: ${missing.join(' ')}`);
  }

  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  buildUrl(pathOrUrl) {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl;
    }
    return `${this.baseUrl}${pathOrUrl}`;
  }

  normalizeCursor(cursor) {
    let c = (cursor || '').trim();
    if (c.startsWith('http://') || c.startsWith('https://')) {
      if (c.includes('start=')) {
        c = c.split('start=')[1];
        if (c.includes('&')) c = c.split('&')[0];
      } else {
        c = c.replace(/\/+$/, '').split('/').pop();
      }
    }
    return c;
  }

  async requestWithRetry(url, params = {}, maxAttempts = 10) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
    const fullUrl = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp;
      try {
        resp = await this.fetchJson(fullUrl, { headers: this.getHeaders() });
      } catch (error) {
        lastError = error;
        const wait = Math.min(30000, 5000 * attempt + Math.random() * 1000);
        console.log(`  ⏳ network error on ${url}, retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }

      const { status } = resp;
      if (status === 429 || (status >= 500 && status <= 599)) {
        const retryAfter = resp.headers['retry-after'];
        const wait = retryAfter
          ? parseFloat(retryAfter) * 1000 + Math.random() * 1000
          : Math.min(30000, Math.pow(2, attempt) * 1000 + Math.random() * 1000);
        console.log(`  ⏳ ${status} on ${url}, retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s`);
        lastError = new Error(`HTTP ${status}`);
        await this.sleep(wait);
        continue;
      }
      return resp;
    }

    throw lastError || new Error(`Max retries (${maxAttempts}) exceeded`);
  }

  disable(name, reason) {
    if (!this.disabledEndpoints.has(name)) {
      this.disabledEndpoints.add(name);
      console.log(`  🚫 DISABLED ${name}: ${reason}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Pagination
  // ────────────────────────────────────────────────────────────

  extractItems(body) {
    if (body && Array.isArray(body.data)) return body.data;
    return [];
  }

  getNextCursor(body) {
    if (body?.page?.next && typeof body.page.next === 'string' && body.page.next.trim()) {
      return body.page.next.trim();
    }
    return null;
  }

  async listAll(name, apiPath, extraParams = {}) {
    if (this.disabledEndpoints.has(name)) {
      return { records: [], stats: { name, ok: false, pages: 0, records: 0, note: 'disabled' } };
    }

    const allItems = [];
    let pages = 0;
    let cursor = null;
    const params = { page_size: this.pageSize, ...extraParams };

    while (pages < this.maxPages) {
      if (cursor) params.start = this.normalizeCursor(cursor);

      const url = this.buildUrl(apiPath);
      const { status, data } = await this.requestWithRetry(url, params);
      await this.sleep(this.sleepBetweenCalls);
      pages++;

      if (status === 404) {
        this.disable(name, '404 not found');
        return { records: allItems, stats: { name, ok: false, pages, records: allItems.length, note: 'http_404' } };
      }
      if (status === 401 || status === 403) {
        this.disable(name, `${status} unauthorized/forbidden`);
        return { records: allItems, stats: { name, ok: false, pages, records: allItems.length, note: `http_${status}` } };
      }
      if (status >= 400) {
        return { records: allItems, stats: { name, ok: false, pages, records: allItems.length, note: `http_${status}` } };
      }

      const items = this.extractItems(data);
      for (const item of items) {
        if (item && typeof item === 'object') allItems.push(item);
      }

      if (this.maxRecords > 0 && allItems.length >= this.maxRecords) {
        allItems.length = this.maxRecords;
        break;
      }

      cursor = this.getNextCursor(data);
      if (!cursor) break;
    }

    return { records: allItems, stats: { name, ok: true, pages, records: allItems.length } };
  }

  // ────────────────────────────────────────────────────────────
  // Singleton fetch
  // ────────────────────────────────────────────────────────────

  async fetchSingleton(name, apiPath) {
    if (this.disabledEndpoints.has(name)) return null;

    const url = this.buildUrl(apiPath);
    const { status, data } = await this.requestWithRetry(url);
    await this.sleep(this.sleepBetweenCalls);

    if (status === 404) { this.disable(name, '404'); return null; }
    if (status === 401 || status === 403) { this.disable(name, `${status}`); return null; }
    if (status >= 400) return null;

    return data;
  }

  // ────────────────────────────────────────────────────────────
  // ID extraction from collected records
  // ────────────────────────────────────────────────────────────

  extractIdsFromRecords(records, idKeys) {
    const seen = new Set();
    const ids = [];
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      let id = null;
      for (const key of idKeys) {
        if (rec[key] !== undefined && rec[key] !== null && rec[key] !== '') {
          id = rec[key];
          break;
        }
      }
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  // ────────────────────────────────────────────────────────────
  // Database storage (mirrors KPA/Fleetio patterns)
  // ────────────────────────────────────────────────────────────

  stripInternalFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const cleaned = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      cleaned[k] = v;
    }
    return cleaned;
  }

  async storeRecords(endpointName, records) {
    if (!records || records.length === 0) return { inserted: 0, updated: 0 };

    const cleanRecords = records.map(r => this.stripInternalFields(r));
    const tableName = endpointName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '');

    try {
      const tableCheck = await this.pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = '${this.schema}' AND table_name = $1
        )
      `, [tableName]);

      const tableExists = tableCheck.rows[0].exists;

      if (!tableExists) {
        console.log(`   🔍 Analyzing schema for ${this.schema}.${tableName}...`);

        const schema = SchemaDetector.analyzeAndGenerateSchema(tableName, cleanRecords);
        if (!schema) {
          console.log(`   ⚠️  Could not detect schema for ${tableName}, skipping`);
          return { inserted: 0, updated: 0 };
        }

        let createTableSQL = schema.createTableSQL
          .replace(/CREATE TABLE IF NOT EXISTS fleetio\./g, `CREATE TABLE IF NOT EXISTS ${this.schema}.`)
          .replace(/fleetio_id BIGINT UNIQUE NOT NULL/g, 'ramp_id TEXT UNIQUE NOT NULL');

        // SchemaDetector always appends ramp_id, synced_at, and raw_data as reserved columns.
        // If the API data also has fields that flatten to these names, they appear as
        // quoted duplicates in the column defs. Remove them to prevent "specified more than once".
        createTableSQL = createTableSQL
          .split('\n')
          .filter(line => {
            const trimmed = line.trim();
            return !trimmed.startsWith('"synced_at"') &&
                   !trimmed.startsWith('"raw_data"') &&
                   !trimmed.startsWith('"ramp_id"');
          })
          .join('\n')
          .replace(/,(\s*synced_at)/g, ',\n  synced_at');

        const indexes = schema.indexes.map(idx =>
          idx.replace(/fleetio\./g, `${this.schema}.`)
             .replace(/fleetio_id/g, 'ramp_id')
        );

        console.log(`   🏗️  Creating table ${this.schema}.${tableName} with ${Object.keys(schema.columns).length} columns...`);

        try {
          await this.pool.query(createTableSQL);
        } catch (createErr) {
          console.error(`   ❌ CREATE TABLE failed for ${tableName}:`, createErr.message);
          throw createErr;
        }

        for (const idxSQL of indexes) {
          try { await this.pool.query(idxSQL); } catch (e) { /* index may already exist */ }
        }

        console.log(`   ✅ Table ${this.schema}.${tableName} created`);
      }

      const columnsResult = await this.pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = '${this.schema}' AND table_name = $1
      `, [tableName]);

      const existingColumns = new Map(columnsResult.rows.map(r => [r.column_name, r.data_type]));

      let inserted = 0;
      let updated = 0;
      let errors = 0;

      for (let ri = 0; ri < records.length; ri++) {
        const record = records[ri];
        const clean = cleanRecords[ri];
        try {
          if (!record) continue;

          let rampId = null;
          for (const idField of ['id', 'user_id', 'card_id', 'bill_id', 'transaction_id', 'transfer_id', 'trip_id']) {
            if (record[idField]) {
              rampId = String(record[idField]);
              break;
            }
          }
          if (!rampId) {
            const crypto = require('crypto');
            rampId = crypto.createHash('md5').update(JSON.stringify(record)).digest('hex');
          }

          const flatRecord = this.flattenObject(clean);

          const RESERVED_COLS = new Set(['id', 'ramp_id', 'synced_at', 'raw_data']);
          const values = {};
          for (const [key, value] of Object.entries(flatRecord)) {
            if (RESERVED_COLS.has(key)) continue;
            const cleanKey = SchemaDetector.cleanFieldName(key);
            if (existingColumns.has(cleanKey) && !RESERVED_COLS.has(cleanKey)) {
              if (value !== null && typeof value === 'object') {
                values[cleanKey] = JSON.stringify(value);
              } else {
                values[cleanKey] = value;
              }
            }
          }

          const existsCheck = await this.pool.query(
            `SELECT id FROM ${this.schema}.${tableName} WHERE ramp_id = $1`, [rampId]
          );

          if (existsCheck.rows.length > 0) {
            const setCols = Object.keys(values);
            if (setCols.length > 0) {
              const setClause = setCols.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
              await this.pool.query(
                `UPDATE ${this.schema}.${tableName}
                 SET ${setClause}, synced_at = NOW(), raw_data = $${setCols.length + 1}
                 WHERE ramp_id = $${setCols.length + 2}`,
                [...Object.values(values), record, rampId]
              );
              updated++;
            }
          } else {
            const cols = Object.keys(values);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            const colNames = cols.map(c => `"${c}"`).join(', ');

            await this.pool.query(
              `INSERT INTO ${this.schema}.${tableName}
               (ramp_id, ${colNames}, raw_data)
               VALUES ($${cols.length + 1}, ${placeholders}, $${cols.length + 2})`,
              [...Object.values(values), rampId, record]
            );
            inserted++;
          }
        } catch (recErr) {
          errors++;
          if (errors <= 5) {
            console.error(`   ⚠️  Error storing record:`, recErr.message);
          }
        }
      }

      if (errors > 0) console.log(`   ⚠️  ${errors} records failed`);
      return { inserted, updated, errors };

    } catch (error) {
      console.error(`❌ Error storing ${endpointName}:`, error.message);
      throw error;
    }
  }

  async storeSingleton(name, data) {
    if (!data || typeof data !== 'object') return;

    const tableName = name;

    try {
      const tableCheck = await this.pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = '${this.schema}' AND table_name = $1
        )
      `, [tableName]);

      if (!tableCheck.rows[0].exists) {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.${tableName} (
            id SERIAL PRIMARY KEY,
            ramp_id TEXT UNIQUE NOT NULL DEFAULT 'singleton',
            raw_data JSONB NOT NULL,
            synced_at TIMESTAMP DEFAULT NOW()
          )
        `);
        console.log(`   🏗️  Created singleton table ${this.schema}.${tableName}`);
      }

      await this.pool.query(`
        INSERT INTO ${this.schema}.${tableName} (ramp_id, raw_data, synced_at)
        VALUES ('singleton', $1, NOW())
        ON CONFLICT (ramp_id)
        DO UPDATE SET raw_data = $1, synced_at = NOW()
      `, [data]);

      console.log(`   💾 Stored singleton ${this.schema}.${tableName}`);
    } catch (error) {
      console.error(`   ❌ Error storing singleton ${name}:`, error.message);
    }
  }

  flattenObject(obj, prefix = '') {
    const flattened = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}_${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(flattened, this.flattenObject(value, newKey));
      } else {
        flattened[newKey] = value;
      }
    }
    return flattened;
  }

  // ────────────────────────────────────────────────────────────
  // Dependent: accounting_field_options (requires field_id)
  // ────────────────────────────────────────────────────────────

  async syncAccountingFieldOptions() {
    const fieldRecords = this.collectedIds['accounting_fields'] || [];
    const allCandidateIds = this.extractIdsFromRecords(fieldRecords, ['id', 'field_id']);

    if (allCandidateIds.length === 0) {
      console.log('⚠️  accounting_field_options: no accounting_fields found, skipping');
      return { name: 'accounting_field_options', skipped: true, reason: 'no_accounting_fields' };
    }

    // Only keep valid UUIDs -- non-UUID values like "Location"/"Division" cause 422
    const fieldIds = allCandidateIds
      .map(id => String(id).trim())
      .filter(id => UUID_RE.test(id));

    if (fieldIds.length === 0) {
      console.log(`⚠️  accounting_field_options: found ${allCandidateIds.length} candidates but 0 UUIDs, skipping`);
      return { name: 'accounting_field_options', skipped: true, reason: 'no_uuid_field_ids' };
    }

    console.log(`\n📥 Expanding accounting_field_options for ${fieldIds.length} UUID fields (skipped ${allCandidateIds.length - fieldIds.length} non-UUID)...`);

    // Build a name map for friendly logging
    const fieldNameMap = {};
    for (const rec of fieldRecords) {
      const fid = rec.id || rec.field_id;
      const fname = rec.name || rec.display_name || rec.label;
      if (fid && fname) fieldNameMap[String(fid)] = String(fname);
    }

    const allOptions = [];
    let failures = 0;

    for (const fid of fieldIds) {
      if (this.disabledEndpoints.has('accounting_field_options')) break;

      const { records, stats } = await this.listAll(
        'accounting_field_options',
        '/developer/v1/accounting/field-options',
        { field_id: fid }
      );

      if (!stats.ok) {
        failures++;
        continue;
      }

      const fname = fieldNameMap[fid];
      for (const opt of records) {
        opt._parent_field_id = fid;
        if (fname) opt._parent_field_name = fname;
        allOptions.push(opt);
      }
    }

    if (allOptions.length > 0) {
      const storeStats = await this.storeRecords('accounting_field_options', allOptions);
      console.log(`✅ accounting_field_options: ${storeStats.inserted} inserted, ${storeStats.updated} updated (${allOptions.length} total, ${failures} field failures)`);
    } else {
      console.log(`⚠️  accounting_field_options: no options found`);
    }

    return { name: 'accounting_field_options', ok: true, records: allOptions.length, failures };
  }

  // ────────────────────────────────────────────────────────────
  // Dependent: matrix_table_rows (requires table_name)
  // ────────────────────────────────────────────────────────────

  async syncMatrixTableRows() {
    const tableRecords = this.collectedIds['matrix_tables'] || [];
    const tableNames = this.extractIdsFromRecords(tableRecords, ['name', 'table_name', 'id']);

    if (tableNames.length === 0) {
      console.log('⚠️  matrix_table_rows: no matrix_tables found, skipping');
      return { name: 'matrix_table_rows', skipped: true, reason: 'parent endpoint (matrix_tables) disabled/empty' };
    }

    console.log(`\n📥 Fetching matrix table rows for ${tableNames.length} tables...`);

    const allRows = [];

    for (const tName of tableNames) {
      const childPath = `/developer/v1/custom-records/matrix-tables/${tName}/rows`;
      const { records, stats } = await this.listAll(`matrix_table_rows:${tName}`, childPath);

      if (!stats.ok) continue;

      for (const row of records) {
        row._parent_table_name = tName;
        allRows.push(row);
      }
    }

    if (allRows.length > 0) {
      const storeStats = await this.storeRecords('matrix_table_rows', allRows);
      console.log(`✅ matrix_table_rows: ${storeStats.inserted} inserted, ${storeStats.updated} updated (${allRows.length} total)`);
    }

    return { name: 'matrix_table_rows', ok: true, records: allRows.length, tables: tableNames.length };
  }

  // ────────────────────────────────────────────────────────────
  // Info endpoints (detail by ID)
  // ────────────────────────────────────────────────────────────

  async syncInfoEndpoint(infoName, spec) {
    const parentRecords = this.collectedIds[spec.parentList] || [];
    let ids = this.extractIdsFromRecords(parentRecords, spec.idKeys);

    if (ids.length === 0) return { name: infoName, skipped: true, reason: `parent list (${spec.parentList}) has 0 records` };

    if (infoName === 'transactions_info' && this.txInfoMaxIds > 0) {
      ids = ids.slice(0, this.txInfoMaxIds);
    }
    if (this.infoMaxIds > 0) {
      ids = ids.slice(0, this.infoMaxIds);
    }

    console.log(`\n📥 Fetching ${infoName} for ${ids.length} IDs...`);

    const allDetails = [];
    let errCount = 0;

    for (const id of ids) {
      if (this.disabledEndpoints.has(infoName)) break;

      const detailPath = spec.pathTpl.replace('{id}', id);
      const url = this.buildUrl(detailPath);

      try {
        const { status, data } = await this.requestWithRetry(url);
        await this.sleep(this.sleepBetweenInfoCalls);

        if (status >= 400) {
          if (status === 401 || status === 403 || status === 404) {
            this.disable(infoName, `http_${status}`);
            break;
          }
          errCount++;
          continue;
        }

        if (data && typeof data === 'object') {
          data._requested_id = id;
          allDetails.push(data);
        }
      } catch (e) {
        errCount++;
        if (errCount <= 3) console.error(`   ⚠️  ${infoName} id=${id}:`, e.message);
      }
    }

    if (allDetails.length > 0) {
      const storeStats = await this.storeRecords(infoName, allDetails);
      console.log(`✅ ${infoName}: ${storeStats.inserted} inserted, ${storeStats.updated} updated (${allDetails.length} ok, ${errCount} errors)`);
    }

    return { name: infoName, ok: true, records: allDetails.length, errors: errCount };
  }

  // ────────────────────────────────────────────────────────────
  // Sanity check
  // ────────────────────────────────────────────────────────────

  async sanityCheck() {
    console.log('[Ramp] Checking API connection...');
    const url = this.buildUrl('/developer/v1/business');
    try {
      const { status, data } = await this.requestWithRetry(url);
      if (status >= 400) {
        throw new Error(`Ramp sanity check failed: HTTP ${status}`);
      }
      console.log('🔎 Connected to Ramp Developer API v1 OK');
      const businessName = [data?.business_name_legal, data?.business_name_on_card].filter(Boolean).join(' / ');
      console.log(`   Business: ${businessName}`);
      if (!businessName.toLowerCase().includes(this.expectedBusiness.toLowerCase())) {
        throw new Error(
          `Ramp credentials belong to "${businessName}", not ${this.label}; refusing to sync into ${this.schema}`
        );
      }
      return true;
    } catch (error) {
      console.error('❌ Ramp sanity check failed:', error.message);
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Main sync
  // ────────────────────────────────────────────────────────────

  async sync() {
    console.log('\n' + '='.repeat(60));
    console.log('   RAMP COMPREHENSIVE SYNC');
    console.log('='.repeat(60));
    console.log(`Base URL: ${this.baseUrl}`);
    console.log(`List Endpoints: ${this.listEndpoints.length}`);
    console.log(`Singleton Endpoints: ${this.singletonEndpoints.length}`);
    console.log(`Info Endpoints: ${Object.keys(this.infoEndpoints).length}`);
    console.log(`Pull Info: ${this.pullInfo}`);
    console.log(`Max Pages: ${this.maxPages}`);
    console.log(`Page Size: ${this.pageSize}`);
    console.log('='.repeat(60) + '\n');

    const startTime = Date.now();
    const results = [];

    // Before anything is written: a key for the wrong business stops here.
    await this.authenticate();
    await this.sanityCheck();

    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    console.log(`✅ ${this.schema} schema ready (${this.label})\n`);

    // ── 1. Singletons ──
    for (const ep of this.singletonEndpoints) {
      console.log(`\n📥 Fetching singleton: ${ep.name}...`);
      try {
        const data = await this.fetchSingleton(ep.name, ep.path);
        if (data) {
          await this.storeSingleton(ep.name, data);
          results.push({ name: ep.name, type: 'singleton', ok: true });
        } else {
          results.push({ name: ep.name, type: 'singleton', ok: false });
        }
      } catch (error) {
        console.error(`❌ ${ep.name}:`, error.message);
        results.push({ name: ep.name, type: 'singleton', ok: false, error: error.message });
      }
    }

    // ── 2. List endpoints ──
    for (const ep of this.listEndpoints) {
      console.log(`\n📥 Syncing list: ${ep.name}...`);
      try {
        const { records, stats } = await this.listAll(ep.name, ep.path);

        this.collectedIds[ep.name] = records;

        if (stats.ok && records.length > 0) {
          const storeStats = await this.storeRecords(ep.name, records);
          console.log(`✅ ${ep.name}: ${storeStats.inserted} inserted, ${storeStats.updated} updated (${stats.pages} pages)`);
        } else if (stats.ok) {
          console.log(`⚠️  ${ep.name}: 0 records (empty)`);
        } else {
          console.log(`⚠️  ${ep.name}: ${stats.note || 'failed'}`);
        }

        results.push({ name: ep.name, type: 'list', ...stats });
      } catch (error) {
        console.error(`❌ ${ep.name}:`, error.message);
        results.push({ name: ep.name, type: 'list', ok: false, error: error.message });
      }
    }

    // ── 3. Dependent: accounting_field_options ──
    try {
      const afoResult = await this.syncAccountingFieldOptions();
      results.push({ ...afoResult, type: 'dependent' });
    } catch (error) {
      console.error('❌ accounting_field_options:', error.message);
      results.push({ name: 'accounting_field_options', type: 'dependent', ok: false, error: error.message });
    }

    // ── 4. Dependent: matrix_table_rows ──
    try {
      const mtrResult = await this.syncMatrixTableRows();
      results.push({ ...mtrResult, type: 'dependent' });
    } catch (error) {
      console.error('❌ matrix_table_rows:', error.message);
      results.push({ name: 'matrix_table_rows', type: 'dependent', ok: false, error: error.message });
    }

    // ── 5. Info endpoints ──
    if (this.pullInfo) {
      for (const [infoName, spec] of Object.entries(this.infoEndpoints)) {
        try {
          const infoResult = await this.syncInfoEndpoint(infoName, spec);
          results.push({ ...infoResult, type: 'info' });
        } catch (error) {
          console.error(`❌ ${infoName}:`, error.message);
          results.push({ name: infoName, type: 'info', ok: false, error: error.message });
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    const totalRecords = results.reduce((s, r) => s + (r.records || 0), 0);
    const succeeded = results.filter(r => r.ok);
    const skipped = results.filter(r => r.skipped);
    const disabled = results.filter(r => !r.ok && !r.skipped && this.disabledEndpoints.has(r.name));
    const failed = results.filter(r => !r.ok && !r.skipped && !this.disabledEndpoints.has(r.name));

    console.log('\n' + '='.repeat(60));
    console.log('   RAMP SYNC COMPLETE');
    console.log('='.repeat(60));
    console.log(`Duration: ${duration} minutes`);
    console.log(`Total Records: ${totalRecords.toLocaleString()}`);
    console.log('');
    console.log(`✅ SUCCEEDED (${succeeded.length}):`);
    succeeded.forEach(r => console.log(`   ${r.name}: ${r.records || 0} records`));
    if (skipped.length > 0) {
      console.log(`\n⏭️  SKIPPED (${skipped.length}):`);
      skipped.forEach(r => console.log(`   ${r.name}: ${r.reason || 'no parent data'}`));
    }
    if (disabled.length > 0) {
      console.log(`\n🚫 DISABLED/404 (${disabled.length}):`);
      disabled.forEach(r => console.log(`   ${r.name}`));
    }
    if (failed.length > 0) {
      console.log(`\n❌ FAILED (${failed.length}):`);
      failed.forEach(r => console.log(`   ${r.name}: ${r.error || r.note || 'unknown'}`));
    }
    console.log('='.repeat(60) + '\n');

    return {
      success: true,
      duration,
      endpoints: succeeded.length,
      records: totalRecords,
      disabled: [...this.disabledEndpoints],
      skipped: skipped.map(r => r.name),
      failed: failed.map(r => r.name),
      results,
    };
  }

}

module.exports = { RampSync, isConfigured, RAMP_READ_SCOPES };
