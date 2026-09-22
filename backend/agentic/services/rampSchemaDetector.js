/**
 * Smart Schema Detector
 * 
 * Analyzes API responses and auto-generates optimal database schema
 * Detects field types, nested objects, and creates proper typed columns
 */

class SchemaDetector {
  /**
   * Analyze API response and generate CREATE TABLE statement
   */
  static analyzeAndGenerateSchema(tableName, records, existingColumns = null) {
    if (!records || records.length === 0) {
      return null;
    }

    // Sample more records to get better field coverage and size estimates
    const sampleSize = Math.min(50, records.length);
    const samples = records.slice(0, sampleSize);

    // Collect all fields and their types
    const fieldAnalysis = {};

    for (const record of samples) {
      this.analyzeObject(record, fieldAnalysis, '');
    }

    // Generate column definitions
    const columns = this.generateColumns(fieldAnalysis);

    // Build CREATE TABLE statement
    const createTableSQL = this.buildCreateTableSQL(tableName, columns);
    
    // Build indexes
    const indexes = this.generateIndexes(tableName, columns);

    return {
      createTableSQL,
      indexes,
      columns: Object.keys(columns)
    };
  }

  /**
   * Recursively analyze object structure
   */
  static analyzeObject(obj, analysis, prefix) {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = prefix ? `${prefix}_${key}` : key;
      
      // Skip 'id' field - it's handled specially as kpa_id/fleetio_id
      if (fieldPath === 'id') {
        continue;
      }
      
      // Skip if field already analyzed
      if (!analysis[fieldPath]) {
        analysis[fieldPath] = {
          name: fieldPath,
          originalKey: key,
          types: new Set(),
          isNested: prefix !== '',
          maxLength: 0,
          samples: []
        };
      }

      const field = analysis[fieldPath];

      // Determine type
      if (value === null || value === undefined) {
        field.types.add('null');
      } else if (typeof value === 'boolean') {
        field.types.add('boolean');
      } else if (typeof value === 'number') {
        field.types.add(Number.isInteger(value) ? 'integer' : 'numeric');
      } else if (typeof value === 'string') {
        field.types.add('string');
        field.maxLength = Math.max(field.maxLength, value.length);
        
        // Check if it's a date/timestamp
        if (this.isDateString(value)) {
          field.types.add('timestamp');
        }
      } else if (typeof value === 'object') {
        if (Array.isArray(value)) {
          field.types.add('array');
          // Don't recurse into arrays - store as JSONB
        } else {
          field.types.add('object');
          // Flatten nested objects (e.g., vehicle.name becomes vehicle_name)
          this.analyzeObject(value, analysis, fieldPath);
        }
      }

      // Store sample value
      if (field.samples.length < 3 && value !== null && typeof value !== 'object') {
        field.samples.push(value);
      }
    }
  }

  /**
   * Check if string looks like a date
   */
  static isDateString(str) {
    if (typeof str !== 'string') return false;
    // ISO 8601 format
    return /^\d{4}-\d{2}-\d{2}/.test(str);
  }

  /**
   * Generate column definitions from analysis
   */
  static generateColumns(fieldAnalysis) {
    const columns = {};

    for (const [fieldPath, field] of Object.entries(fieldAnalysis)) {
      // Skip if it's an object parent (nested fields handled separately)
      if (field.types.has('object') && !field.types.has('array')) {
        continue;
      }

      // Determine SQL type
      let sqlType = this.determineSQLType(field);
      
      // Clean field name for SQL
      const columnName = this.cleanFieldName(fieldPath);
      
      columns[columnName] = {
        sqlType,
        originalPath: fieldPath,
        isImportant: this.isImportantField(columnName)
      };
    }

    return columns;
  }

  /**
   * Determine best SQL type for field
   */
  static determineSQLType(field) {
    const types = Array.from(field.types);
    
    // Remove null from consideration if other types exist
    const nonNullTypes = types.filter(t => t !== 'null');
    
    if (nonNullTypes.length === 0) {
      return 'TEXT';
    }

    // Priority: timestamp > numeric > integer > boolean > array/object > string
    if (nonNullTypes.includes('timestamp')) {
      return 'TIMESTAMP';
    }
    // Use NUMERIC for any number (integer OR decimal). A field that only contains
    // whole numbers in the first sampled records can still carry decimals later
    // (hours, costs, quantities), which previously broke BIGINT columns with
    // "invalid input syntax for type bigint: 8.25". NUMERIC stores both safely.
    // Primary/unique IDs (fleetio_id, qb_id) are defined separately and unaffected.
    if (nonNullTypes.includes('numeric') || nonNullTypes.includes('integer')) {
      return 'NUMERIC';
    }
    if (nonNullTypes.includes('boolean')) {
      return 'BOOLEAN';
    }
    if (nonNullTypes.includes('array') || nonNullTypes.includes('object')) {
      return 'JSONB';
    }

    // Strings: always TEXT. Fixed-length VARCHAR caused "value too long for type
    // character varying" whenever a later record exceeded the length inferred from
    // the first sample. TEXT has no length cap and no performance penalty in Postgres.
    return 'TEXT';
  }

  /**
   * Clean field name for SQL compatibility
   */
  static cleanFieldName(name) {
    let cleaned = name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    
    // Handle SQL reserved keywords
    const reservedKeywords = [
      'default', 'user', 'group', 'order', 'table', 'index', 'primary', 
      'foreign', 'key', 'select', 'from', 'where', 'update', 'delete',
      'insert', 'create', 'drop', 'alter', 'grant', 'revoke'
    ];
    
    if (reservedKeywords.includes(cleaned)) {
      cleaned = cleaned + '_value';  // e.g., "default" becomes "default_value"
    }
    
    return cleaned;
  }

  /**
   * Check if field is important (for indexing)
   */
  static isImportantField(name) {
    const importantFields = [
      'id', 'fleetio_id', 'name', 'vehicle_id', 'vehicle_name',
      'date', 'created_at', 'updated_at', 'status', 'state',
      'vin', 'license_plate', 'vendor_name', 'email'
    ];
    return importantFields.includes(name);
  }

  /**
   * Build CREATE TABLE SQL statement
   */
  static buildCreateTableSQL(tableName, columns) {
    const columnDefs = [];
    
    // Always add primary key
    columnDefs.push('id SERIAL PRIMARY KEY');
    
    // Add fleetio_id if not already present
    if (!columns.fleetio_id) {
      columnDefs.push('fleetio_id BIGINT UNIQUE NOT NULL');
    }

    // Add detected columns (with quoted names for SQL keywords)
    for (const [name, info] of Object.entries(columns)) {
      if (name === 'id') continue; // Already added as primary key
      
      // Quote column name to handle reserved keywords
      let def = `"${name}" ${info.sqlType}`;
      
      // Add UNIQUE constraint for fleetio_id
      if (name === 'fleetio_id') {
        def = `"${name}" BIGINT UNIQUE NOT NULL`;
      }
      
      columnDefs.push(def);
    }

    // Add metadata columns
    columnDefs.push('synced_at TIMESTAMP DEFAULT NOW()');
    columnDefs.push('raw_data JSONB');  // Backup of full API response

    return `
CREATE TABLE IF NOT EXISTS fleetio.${tableName} (
  ${columnDefs.join(',\n  ')}
);`;
  }

  /**
   * Generate indexes for important fields
   */
  static generateIndexes(tableName, columns) {
    const indexes = [];

    for (const [name, info] of Object.entries(columns)) {
      if (info.isImportant) {
        // Quote column names in indexes too
        indexes.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_${name} ON fleetio.${tableName}("${name}");`);
      }
    }

    // Always add GIN index for raw_data JSONB
    indexes.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_raw_gin ON fleetio.${tableName} USING GIN(raw_data);`);
    
    // Always add synced_at index for monitoring
    indexes.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_synced ON fleetio.${tableName}(synced_at DESC);`);

    return indexes;
  }

  /**
   * Extract column values from API record
   */
  static extractValues(record, columns) {
    const values = {};
    
    // Flatten nested objects
    const flattened = this.flattenObject(record);
    
    for (const columnName of Object.keys(columns)) {
      const value = flattened[columnName];
      values[columnName] = value !== undefined ? value : null;
    }
    
    // Add fleetio_id if not in columns
    if (!values.fleetio_id && record.id) {
      values.fleetio_id = record.id;
    }
    
    // Add raw_data
    values.raw_data = record;
    
    return values;
  }

  /**
   * Flatten nested object (vehicle.name → vehicle_name)
   */
  static flattenObject(obj, prefix = '') {
    const flattened = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const fieldName = prefix ? `${prefix}_${key}` : key;
      
      if (value === null || value === undefined) {
        flattened[fieldName] = null;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        // Recurse for nested objects
        Object.assign(flattened, this.flattenObject(value, fieldName));
      } else {
        // Store primitive or array
        flattened[fieldName] = value;
      }
    }
    
    return flattened;
  }

  /**
   * Self-heal column types for a record that failed to insert due to a type/length
   * mismatch. Widens narrow legacy columns in place so the retry (and all future
   * runs) succeed:
   *   - BIGINT/INTEGER column receiving a decimal value  -> NUMERIC
   *   - VARCHAR(n) column receiving an over-length string -> TEXT
   *
   * `schemaQualifiedTable` e.g. "fleetio.service_entries".
   * `colValueTypes` is an array of { name, value, dataType, maxLength }.
   * Returns true if at least one column was widened.
   */
  static async widenColumnsForRecord(pool, schemaQualifiedTable, colValueTypes) {
    const alters = [];

    for (const c of colValueTypes) {
      if (c.value === null || c.value === undefined) continue;
      const dt = (c.dataType || '').toLowerCase();

      if (dt === 'bigint' || dt === 'integer' || dt === 'smallint') {
        const isDecimal =
          (typeof c.value === 'number' && !Number.isInteger(c.value)) ||
          (typeof c.value === 'string' && /^-?\d*\.\d+$/.test(c.value.trim()));
        if (isDecimal) alters.push({ name: c.name, type: 'NUMERIC' });
      } else if (dt === 'character varying') {
        if (typeof c.value === 'string' && c.maxLength && c.value.length > c.maxLength) {
          alters.push({ name: c.name, type: 'TEXT' });
        }
      }
    }

    let widened = false;
    for (const a of alters) {
      const using = a.type === 'NUMERIC' ? ` USING "${a.name}"::numeric` : '';
      try {
        await pool.query(
          `ALTER TABLE ${schemaQualifiedTable} ALTER COLUMN "${a.name}" TYPE ${a.type}${using}`
        );
        console.log(`   🔧 Auto-widened ${schemaQualifiedTable}."${a.name}" -> ${a.type}`);
        widened = true;
      } catch (e) {
        console.error(`   ⚠️  Could not widen ${schemaQualifiedTable}."${a.name}":`, e.message);
      }
    }

    return widened;
  }
}

module.exports = SchemaDetector;
