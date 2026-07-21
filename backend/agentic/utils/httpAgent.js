/**
 * Shared outbound HTTPS agent for LLM API calls.
 *
 * Production lesson (Part 14): force IPv4 and DISABLE keep-alive. Reused
 * sockets on cloud runtimes intermittently die mid-stream and surface as
 * ERR_STREAM_PREMATURE_CLOSE from the Anthropic/OpenAI SDKs.
 */
const https = require('https');

const llmHttpsAgent = new https.Agent({
  keepAlive: false,
  family: 4,
  timeout: 120000,
});

module.exports = { llmHttpsAgent };
