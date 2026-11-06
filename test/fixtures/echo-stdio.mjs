/**
 * Minimal stdio MCP server fixture: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Used by future probe tests. Deliberately standalone: no imports, no dependencies.
 * Run: node test/fixtures/echo-stdio.mjs
 */

const TOOLS = [
  { name: 'echo', description: 'Echo the given text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'echo_reverse', description: 'Echo the given text reversed', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

let buffer = '';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  // Requests get a JSON-RPC error; notifications (no id) stay silent.
  if (message.id !== undefined && message.id !== null) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
