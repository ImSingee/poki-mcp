// The stdio MCP server an MCP client starts. It answers tools/list itself and forwards each tools/call
// to the one shared daemon for this state directory. Only a tool call starts that daemon when none
// runs (src/daemon-launch.mjs); nothing else this shim sends does, so a daemon the user stopped stays
// stopped until the next call. The daemon's token stays in mcp.json (mode 0600); clients never see it.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './tools.mjs';
import { endpointFile } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { version } from './build-info.mjs';
import { ensureDaemon, runningDaemon, olderRelease } from './daemon-launch.mjs';
import { approvalMode, stricterApproval } from './human.mjs';

let endpoint;
const session = process.env.POKI_MCP_SESSION ?? randomUUID();
// While this shim lives it says so every heartbeatMs. The daemon closes a session whose shim has gone
// quiet (killed without closing it), even while that session holds leases or background work. Process
// ids are not used for this: the daemon may run in another PID namespace (a container).
const heartbeatMs = Math.min(60000, Math.max(100, Number(process.env.POKI_MCP_HEARTBEAT_MS) || 10000));
// Calls travel to the daemon as separate HTTP requests, which may arrive out of order. Each carries
// its place in this shim's order, and the daemon queues them on their devices in that order. The
// numbering starts again at 1 for every daemon this shim reaches, and a call is numbered when it is
// sent: a call sent again to a new daemon takes its place there before any call made after it.
let stream = randomUUID(), sequence = 0;
const nextOrder = () => ({ stream, seq: ++sequence });
const send = (path, init, to = endpoint) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${to.token}`);
  headers.set('x-poki-mcp-session', session);
  headers.set('x-poki-mcp-heartbeat-ms', String(heartbeatMs));
  return fetch(new URL(path, to.url), { ...init, headers });
};
const refused = error => error.cause?.code === 'ECONNREFUSED';
const lost = error => error.name === 'TypeError' && error.cause ? new Error('The connection to Poki MCP was lost during this call. The device may already have acted, so look at the screen before retrying.') : error;
// POKI_MCP_AUTOSTART=0: this client only uses a daemon that runs (a container whose daemon runs in
// another container, which has the USB connection).
const autostart = process.env.POKI_MCP_AUTOSTART !== '0';
const unavailable = () => Object.assign(new Error(autostart
  ? `Poki MCP is not running (no service answers for ${endpointFile}). The next tool call starts it.`
  : `Poki MCP is not running (no service answers for ${endpointFile}), and POKI_MCP_AUTOSTART=0 keeps this client from starting one. Start the service, then retry.`), { code: 'poki_unavailable' });
// The approval mode this client's environment asks for explicitly, when it is stricter than the one
// the shared daemon runs with: calls are then refused rather than run under the weaker mode.
const requestedMode = (() => { if (!process.env.POKI_MCP_APPROVAL_MODE?.trim()) return undefined; try { return approvalMode(); } catch { return undefined; } })();
let modeConflict;
// Reaches the daemon named in mcp.json. With start (a tool call only), also starts or replaces it.
async function connectDaemon({ start }) {
  const previous = endpoint?.pid;
  if (start && autostart) endpoint = await ensureDaemon();
  else {
    const running = await runningDaemon().catch(() => null);
    if (!running?.info) throw unavailable();
    endpoint = { ...running.endpoint, info: running.info };
  }
  if (endpoint.pid !== previous) { stream = randomUUID(); sequence = 0; }
  const daemonMode = endpoint.info?.approval_mode;
  modeConflict = requestedMode && daemonMode && daemonMode !== requestedMode ? { requested: requestedMode, running: daemonMode, pid: endpoint.info.pid, stricter: stricterApproval(requestedMode, daemonMode) } : undefined;
}
// Requests refused together reconnect once, and are sent again in the order they were refused; calls
// made meanwhile wait behind them.
let reconnecting;
async function reconnect(start, failed) {
  while (reconnecting) await reconnecting.catch(() => {});
  if (endpoint && endpoint !== failed) return;
  reconnecting = connectDaemon({ start });
  try { await reconnecting; } finally { reconnecting = undefined; }
}
const toolCall = init => {
  if (init?.method !== 'POST' || typeof init.body !== 'string') return undefined;
  try { const message = JSON.parse(init.body); return message?.method === 'tools/call' ? message : undefined; } catch { return undefined; }
};
// A 401 or a refused connection means the daemon never ran the request, so sending it once more cannot
// repeat anything on the device: a restarted daemon has a new token and port. Only a tool call starts
// a daemon that is gone; the client's own requests (its background stream, closing) fail instead. Any
// other lost connection can repeat input, so that one is reported and not sent again.
async function request(path, init) {
  const call = toolCall(init);
  while (reconnecting) await reconnecting.catch(() => {});
  if (!endpoint) await reconnect(Boolean(call), undefined);
  const attempt = async () => {
    const to = endpoint;
    let body = init?.body;
    if (call) {
      const meta = call.params._meta ??= {};
      if (meta['poki/order']?.stream !== stream) meta['poki/order'] = nextOrder();
      body = JSON.stringify(call);
    }
    try {
      const response = await send(path, { ...init, body }, to);
      if (response.status !== 401) return { response };
      await response.body?.cancel();
      return { retry: to, status: 401 };
    } catch (error) {
      if (!refused(error)) throw lost(error);
      return { retry: to };
    }
  };
  const first = await attempt();
  if (first.response) return first.response;
  await reconnect(Boolean(call), first.retry);
  const second = await attempt();
  if (second.response) return second.response;
  if (second.status === 401) throw new Error(`The running Poki MCP rejected the token in ${endpointFile}. Stop it; the next call starts it again.`);
  throw call ? new Error(`Poki MCP (pid ${endpoint.pid}) refused the connection. Retry the call.`) : unavailable();
}
// Closing a session, cancelling a call and the heartbeat are sent once, to the daemon this shim knows:
// when that one is gone there is nothing to close, cancel or keep, and starting a new daemon for it
// would be wasted.
const controls = new Set();
const control = (path, extra = {}) => {
  if (!endpoint) return Promise.resolve();
  const result = send(path, { method: 'POST', headers: extra, signal: AbortSignal.timeout(35000) }).then(response => response.body?.cancel());
  controls.add(result); result.finally(() => controls.delete(result)).catch(() => {});
  return result;
};
let remote, connected, beating;
const heartbeat = setInterval(() => {
  if (!connected || !endpoint || beating) return;
  beating = send('/session/heartbeat', { method: 'POST', signal: AbortSignal.timeout(Math.max(5000, heartbeatMs)) })
    .then(response => response.body?.cancel(), () => {}).finally(() => { beating = undefined; });
}, heartbeatMs);
heartbeat.unref();
const connectClient = start => (async () => {
  const client = new Client({ name: 'poki-mcp-bridge', version });
  await reconnect(start, endpoint);
  await client.connect(new StreamableHTTPClientTransport(endpoint.url, { fetch: (input, init) => request(new URL(input).pathname, init) }));
  return connected = client;
})().catch(error => { remote = undefined; throw error; });
// Connected on the first call (or to a daemon already running while tools are listed), so listing
// tools never starts a daemon.
async function remoteClient(start) {
  try { return await (remote ??= connectClient(start)); }
  catch (error) { if (!start) throw error; return await (remote ??= connectClient(true)); }
}
const sessionTools = new Set(['poki_mcp_status', 'list_devices']);
const conflictText = conflict => `This client asks for approval mode ${conflict.requested} (POKI_MCP_APPROVAL_MODE), but the running Poki MCP service (pid ${conflict.pid}) uses ${conflict.running}, set by the client that started it.`;
const server = createServer(async (name, args, extra) => {
  const id = randomUUID();
  const cancel = () => { if (endpoint) void control('/request/cancel', { 'x-poki-request': id }).catch(() => {}); };
  extra.signal.addEventListener('abort', cancel, { once: true });
  try {
    extra.signal.throwIfAborted();
    const client = await remoteClient(true);
    if (modeConflict?.stricter && !sessionTools.has(name)) return { isError: true, content: [{ type: 'text', text: `${conflictText(modeConflict)} Device tools are refused so they do not run under the weaker mode. Stop that service (kill ${modeConflict.pid}); the next call starts one with this client's mode.` }] };
    const call = () => client.callTool({ name, arguments: args, _meta: { 'poki/request_id': id } }, { timeout: 3700000, signal: extra.signal });
    let result = await call();
    // A service this kind of shim started, refusing the call before it touched a device because its
    // files changed (an update): replace it, as a new shim would, and send the call once more.
    if (result.isError && result._meta?.stale_code === 'auto') {
      try { await reconnect(true, endpoint); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
      result = await call();
    }
    if (modeConflict && name === 'poki_mcp_status') result = { ...result, content: [...(result.content ?? []), { type: 'text', text: `${conflictText(modeConflict)} The service's mode applies${modeConflict.stricter ? '; device tools are refused until it is restarted' : ''}.` }] };
    return result;
  } finally { extra.signal.removeEventListener('abort', cancel); }
});
const transport = new StdioServerTransport();
await server.connect(transport);
// A current daemon that already runs is reached now, while the client is still listing tools, so its
// first call does not wait for that. None is started here: listing tools never starts one.
void runningDaemon().then(running => {
  if (running?.info && !running.info.stale && !olderRelease(running.info.version, version)) return remoteClient(false);
}).catch(() => {});
let stopping;
function stop() {
  return stopping ??= (async () => {
    clearInterval(heartbeat);
    // A shim that never reached a daemon has no session to close, and must not start one to close it.
    if (connected) await control('/session/close').catch(() => {});
    await Promise.allSettled([...controls]);
    await server.close(); await connected?.close().catch(() => {});
    // A first call still waiting for a daemon to start must not keep this process alive.
    setTimeout(() => process.exit(0), 1000).unref();
  })();
}
process.stdin.once('end', () => { void stop(); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
