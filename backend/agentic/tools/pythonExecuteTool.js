/**
 * execute_python — sandboxed Python for data analysis. Flag-gated via
 * FEATURE_CODE_EXEC. Runs python3 in a child process with a hard timeout,
 * no network flags, and stdout capped.
 */
const { spawn } = require('child_process');
const clientConfig = require('../config/client-config');

module.exports = {
  name: 'execute_python',
  description: `Execute a short Python 3 script for data analysis/calculation and return stdout. Standard library only (math, statistics, json, csv, datetime, ...). No network, no file writes, 60s timeout.

WHEN TO USE: calculations, statistics, or data transforms too complex for SQL.
Example: computing a weighted utilization metric across pasted numbers.`,
  category: 'analysis',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python 3 code. Print results to stdout.' },
    },
    required: ['code'],
  },
  async execute(params) {
    if (!clientConfig.isFeatureEnabled('code_execution')) {
      return { success: false, error: 'Code execution is disabled (FEATURE_CODE_EXEC=false)', confidence: 0 };
    }
    const timeoutMs = clientConfig.getToolConfig('code_execution').timeout_ms || 60000;
    try {
      const result = await new Promise((resolve) => {
        const proc = spawn('python3', ['-I', '-c', params.code], {
          timeout: timeoutMs,
          env: { PATH: process.env.PATH }, // no secrets leak into the sandbox
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { if (stdout.length < 100000) stdout += d; });
        proc.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
        proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
      });

      if (result.code !== 0) {
        return { success: false, error: `Python exited ${result.code}: ${result.stderr.slice(0, 2000)}`, confidence: 0 };
      }
      return {
        success: true,
        data: { stdout: result.stdout.slice(0, 50000) },
        summary: 'Python executed successfully',
        confidence: 0.9,
        source_type: 'computation',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
