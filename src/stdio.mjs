// The stdio MCP server an MCP client starts. It answers tools/list itself and forwards each tools/call
// to the one shared daemon for this state directory, starting that daemon when none runs
// (src/daemon-launch.mjs). The daemon's token stays in mcp.json (mode 0600); clients never see it.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './tools.mjs';
import { endpointFile } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { version } from './build-info.mjs';
import { ensureDaemon, alive } from './daemon-launch.mjs';
import { approvalMode } from './human.mjs';

let endpoint;
const session = process.env.POKI_MCP_SESSION ?? randomUUID();
// Calls travel to the daemon as separate HTTP requests, which may arrive out of order. Each carries
// its place in this shim's order, and the daemon queues them on their devices in that order.
const stream = randomUUID();
let sequence = 0;
const send = (path, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${endpoint.token}`);
  headers.set('x-poki-mcp-session', session);
  // Lets the daemon drop this session if this process dies without closing it.
  headers.set('x-poki-mcp-client-pid', String(process.pid));
  return fetch(new URL(path, endpoint.url), { ...init, headers });
};
const refused = error => error.cause?.code === 'ECONNREFUSED';
const lost = error => error.name === 'TypeError' && error.cause ? new Error('The connection to Poki MCP was lost during this call. The device may already have acted, so look at the screen before retrying.') : error;
let checkedMode = false;
async function connectDaemon() {
  endpoint = await ensureDaemon();
  if (checkedMode) return;
  checkedMode = true;
  // The daemon's environment decides approvals. One started by another client may differ from this one's.
  const own = (() => { try { return approvalMode(); } catch { return undefined; } })();
  const info = await fetch(new URL('/version', endpoint.url), { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
  if (own && info?.approval_mode && info.approval_mode !== own) console.error(`Poki MCP: the running service (pid ${info.pid}) uses approval mode ${info.approval_mode}, not ${own} from this client's environment. Its mode applies.`);
}
// A 401 or a refused connection means the daemon never ran the request, so sending it once more cannot
// repeat anything on the device: a restarted daemon has a new token and port, and a dead one is started
// again. Any other lost connection can repeat input, so that one is reported and not sent again.
async function request(path, init) {
  if (!endpoint) await connectDaemon();
  try {
    const response = await send(path, init);
    if (response.status !== 401) return response;
    await response.body?.cancel();
  } catch (error) {
    if (!refused(error)) throw lost(error);
  }
  await connectDaemon();
  let response;
  try { response = await send(path, init); }
  catch (error) { throw refused(error) ? new Error(`Poki MCP (pid ${endpoint.pid}${alive(endpoint.pid) ? '' : ', now stopped'}) refused the connection. Retry the call.`) : lost(error); }
  if (response.status !== 401) return response;
  await response.body?.cancel();
  throw new Error(`The running Poki MCP rejected the token in ${endpointFile}. Stop it; the next call starts it again.`);
}
const controls = new Set();
const control = (path, extra = {}) => {
  const result = request(path, { method: 'POST', headers: extra, signal: AbortSignal.timeout(35000) });
  controls.add(result); result.finally(() => controls.delete(result)).catch(() => {});
  return result;
};
let remote;
// Connected on the first call, so listing tools never starts a daemon.
const remoteClient = () => remote ??= (async () => {
  const client = new Client({ name: 'poki-mcp-bridge', version });
  await connectDaemon();
  await client.connect(new StreamableHTTPClientTransport(endpoint.url, { fetch: (input, init) => request(new URL(input).pathname, init) }));
  return client;
})().catch(error => { remote = undefined; throw error; });
const server = createServer(async (name, args, extra) => {
  const id = randomUUID(), order = { stream, seq: ++sequence };
  const cancel = () => { if (endpoint) void control('/request/cancel', { 'x-poki-request': id }).catch(() => {}); };
  extra.signal.addEventListener('abort', cancel, { once: true });
  try {
    extra.signal.throwIfAborted();
    const client = await remoteClient();
    return await client.callTool({ name, arguments: args, _meta: { 'poki/request_id': id, 'poki/order': order } }, { timeout: 3700000, signal: extra.signal });
  } finally { extra.signal.removeEventListener('abort', cancel); }
});
const transport = new StdioServerTransport();
await server.connect(transport);
let stopping;
function stop() {
  return stopping ??= (async () => {
    // A shim that never reached a daemon has no session to close, and must not start one to close it.
    if (remote) await control('/session/close').catch(() => {});
    await Promise.allSettled([...controls]);
    await server.close(); await (await remote?.catch(() => undefined))?.close();
  })();
}
process.stdin.once('end', () => { void stop(); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
