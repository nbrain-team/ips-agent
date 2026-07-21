/**
 * ToolRegistry — auto-loads every .js in /agentic/tools that exports an
 * object with { name, execute }. Class-based tools (smart DB tool) are
 * instantiated by the orchestrator separately.
 */
const fs = require('fs');
const path = require('path');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new Error('Tool must have { name, execute }');
    }
    this.tools.set(tool.name, tool);
  }

  loadToolsFromDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      try {
        const mod = require(path.join(dir, file));
        if (mod && mod.name && typeof mod.execute === 'function') {
          this.register(mod);
          console.log(`🔧 Tool loaded: ${mod.name}`);
        }
      } catch (err) {
        console.warn(`⚠️  Failed to load tool ${file}: ${err.message}`);
      }
    }
  }

  get(name) {
    return this.tools.get(name);
  }

  getAll() {
    return [...this.tools.values()];
  }

  /** Convert registered tools into Claude tool schemas. */
  getToolSchemas() {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description || t.name,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }
}

module.exports = ToolRegistry;
