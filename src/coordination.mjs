import { randomUUID } from 'node:crypto';
import { work, checkWork, stoppingReason } from './work.mjs';
import { inputLockFromEnv } from './input-lock.mjs';
import { definitions, pairingTools } from './tools.mjs';

const readOnlyTools = new Set(definitions.filter(d => d[3]).map(d => d[0]));

export const managementTools = new Set(['acquire_device', 'renew_device', 'release_device', 'cancel_device']);

// Tools that skip the per-device queue and the input lock: they run as soon as they arrive, beside
// whatever the device is doing. For calls that only read state kept in the daemon (a stream's next
// frames, a pairing job's progress) or feed a view's own input channel, where waiting behind a
// long batch would stall the view. The pairing tools are such calls: they change this computer's
// pairing state, and unpair_device ends a device's queued work itself.
export const unqueuedTools = new Set(pairingTools);

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = error => ({ isError: true, ...text(error.message), _meta: { stop_reason: error.name === 'TimeoutError' ? 'timeout' : error.name === 'AbortError' ? stoppingReason(error) : 'error' } });

// How calls share the devices:
// - Each (session, device) pair keeps the order its calls arrived in. Calls to different devices,
//   from one session or several, run side by side.
// - A tool that changes the screen holds its device's input lock for the whole call; a read takes a
//   read slot instead and runs beside another session's input (input-lock.mjs).
// - A lease keeps every other session off its device. A session may hold leases on several devices.
export class Coordination {
  leases = new Map(); operations = new Set(); revisions = new Map(); scenes = new Map();
  // Devices being unpaired: no session may resolve, lease or act on them until the removal ends.
  unavailable = new Map();
  inputLock = inputLockFromEnv();
  unqueued = unqueuedTools;
  revision(id) { return this.revisions.get(id) ?? 0; }
  changed(id) { this.revisions.set(id, this.revision(id) + 1); }
  observeFrame(id, data) { const previous = this.scenes.get(id); if (previous && !previous.equals(data)) this.changed(id); this.scenes.set(id, data); }
  // The leases this session holds, one per device.
  owned(session) { return [...this.leases.values()].filter(lease => lease.owner === session); }
  status(id, session) {
    const lease = this.leases.get(id);
    return lease ? { occupied: true, owned_by_session: lease.owner === session, state: lease.state, expires_at: lease.expires_at } : { occupied: false };
  }
  access(session, target) {
    checkWork();
    if (this.unavailable.has(target.id)) throw new Error(this.unavailable.get(target.id));
    const lease = this.leases.get(target.id);
    if (lease && (lease.owner !== session || lease.state !== 'active' || performance.now() >= lease.until)) throw new Error('Device is occupied or being released.');
    const operation = work.getStore()?.operation;
    if (operation) operation.devices.add(target.id);
  }
  async acquire(session, target, ttl) {
    this.access(session, target);
    if (this.leases.get(target.id)?.owner === session) throw new Error(`This session already holds a lease on ${target.id}. Use renew_device.`);
    if ([...this.operations].some(op => op.owner !== session && op.devices.has(target.id))) throw new Error('Device has an active operation. Retry after it completes.');
    // A previous compatibility recording/location is owned work too.
    for (const owner of session.peers?.() ?? []) if (owner !== session && owner.backgroundDevices.has(target.id)) throw new Error('Device has background work in another session. Its owner must stop or cancel it first.');
    const lease = { lease_id: randomUUID(), device: target.id, owner: session, state: 'active' };
    this.leases.set(target.id, lease); this.extend(lease, ttl);
    return this.receipt(lease);
  }
  extend(lease, ttl) {
    clearTimeout(lease.timer); lease.until = performance.now() + ttl * 1000; lease.expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    lease.timer = setTimeout(() => { void this.end(lease.owner, 'expired', [lease.device]); }, ttl * 1000); lease.timer.unref();
  }
  receipt(lease) { return { lease_id: lease.lease_id, device: lease.device, state: lease.state, expires_at: lease.expires_at }; }
  require(session, id) {
    const lease = this.owned(session).find(lease => lease.lease_id === id);
    if (!lease || lease.state !== 'active' || performance.now() >= lease.until) throw new Error('No active lease matching this session and lease_id.');
    return lease;
  }
  renew(session, id, ttl) { const lease = this.require(session, id); this.extend(lease, ttl); return this.receipt(lease); }
  // Stops this session's accepted work, on the given devices or on all of them, waits for it and for
  // the recordings and locations it started there to end, and drops its leases there. Work on other
  // devices, and other sessions' work, carries on.
  async end(session, reason, devices) {
    const scope = devices ? new Set(devices) : undefined;
    const overlaps = op => !scope || [...op.devices].some(id => scope.has(id));
    const existing = [...session.endings].find(entry => entry.scope === undefined || (scope && [...scope].every(id => entry.scope.has(id))));
    if (existing) return existing.promise;
    const leases = this.owned(session).filter(lease => !scope || scope.has(lease.device));
    for (const lease of leases) { lease.state = 'releasing'; clearTimeout(lease.timer); }
    const operations = [...this.operations].filter(op => op.owner === session && overlaps(op));
    // A call accepted before this stop that is still finding its device is stopped when it gets there.
    session.stoppedAt ??= new Map();
    for (const id of scope ?? ['*']) session.stoppedAt.set(id, { at: performance.now(), reason });
    for (const op of operations) op.controller.abort(Object.assign(new DOMException(`Session work ${reason}; dispatched input is not undone`, 'AbortError'), { stopReason: reason }));
    const entry = { scope };
    entry.promise = (async () => {
      await Promise.allSettled(operations.map(op => op.done));
      const cleanup = await session.cleanup(scope);
      for (const lease of leases) if (this.leases.get(lease.device) === lease) this.leases.delete(lease.device);
      const named = leases.length === 1 ? { device: leases[0].device, lease_id: leases[0].lease_id } : {};
      return { stopped: true, reason, cancelled_operations: operations.length,
        scope: scope ? `previously accepted work on ${[...scope].join(', ')} in this MCP session` : 'all previously accepted work in this MCP session',
        ...(scope ? { devices: [...scope] } : {}), ...named, ...(leases.length > 1 ? { leases: leases.map(lease => ({ device: lease.device, lease_id: lease.lease_id })) } : {}), cleanup };
    })();
    session.endings.add(entry);
    try { return await entry.promise; } finally { session.endings.delete(entry); }
  }
  // Runs one tool call for a session: resolves which devices it acts on (in arrival order for the
  // session, so two calls to one device cannot swap places while their device names are looked up),
  // waits behind the session's earlier calls to those devices, takes the lock, then runs it.
  call(session, name, args, requestSignal, requestId, order) {
    const controller = new AbortController();
    const op = { owner: session, controller, requestId, devices: new Set(), timings: [], accepted: performance.now() };
    this.operations.add(op);
    const combined = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    const queued = performance.now();
    let started = false, abortQueued;
    const cancelledBeforeStart = new Promise((_, reject) => { abortQueued = () => { if (!started) reject(combined.reason); }; combined.addEventListener('abort', abortQueued, { once: true }); });
    const store = { operation: op, signal: combined, timings: op.timings };
    // Routed after the calls sent before it by the same client (session.inOrder) and after the calls
    // that reached this session before it, and put on its devices' queues before the next one is
    // routed: so two calls to one device cannot swap places while their device names are looked up.
    const place = route => {
      for (const id of route.keys) op.devices.add(id);
      const stop = [...route.keys, '*'].map(id => session.stoppedAt?.get(id)).find(stop => stop && stop.at >= op.accepted);
      if (stop) throw Object.assign(new DOMException(`Session work ${stop.reason}; dispatched input is not undone`, 'AbortError'), { stopReason: stop.reason });
      if ([...session.endings].some(entry => !entry.scope || route.keys.some(id => entry.scope.has(id)))) throw new Error('Session cleanup is in progress.');
      const bypass = this.unqueued.has(name);
      const earlier = bypass ? [] : route.keys.map(id => session.queues.get(id)).filter(Boolean);
      let release;
      const turn = Promise.all(earlier).then(() => bypass ? undefined
        : readOnlyTools.has(name) ? this.inputLock.readSlot(combined)
        : this.inputLock.acquire(route.keys, { session: session.label, tool: name }, combined)).then(r => { release = r; });
      const settled = turn.then(() => work.run(store, async () => {
        started = true; combined.removeEventListener('abort', abortQueued);
        checkWork();
        op.timings.push({ id: 0, phase: 'queue', parent: null, elapsed_ms: Math.round((performance.now() - queued) * 100) / 100 });
        let result;
        try {
          try { result = await route.run(); }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }], _meta: { stop_reason: error.name === 'TimeoutError' || combined.aborted ? stoppingReason(error) : 'error', ...(error.code === 'stale_code' ? { stale_code: error.serviceStart } : {}) } }; }
          result._meta = { ...result._meta, timing: { relation: 'nested phases include their children; do not sum parents and children', stages: op.timings } };
          return result;
        } finally { if (combined.aborted) { const cleanup = await work.run(undefined, () => session.cleanup(op.devices)); if (result) result._meta = { ...result._meta, cleanup }; } }
      })).finally(() => release?.());
      if (!bypass) for (const id of route.keys) session.queues.set(id, settled.catch(() => {}));
      return { settled };
    };
    const placed = (session.inOrder?.(order) ?? Promise.resolve()).then(() => {
      const routed = session.routing.then(() => work.run(store, () => session.route(name, args))).then(place);
      session.routing = routed.then(() => {}, () => {});
      session.placed?.(order);
      return routed;
    });
    const execution = placed.then(({ settled }) => settled, error => { started = true; return failure(error); });
    op.done = Promise.race([execution, cancelledBeforeStart]).finally(() => { combined.removeEventListener('abort', abortQueued); this.operations.delete(op); });
    return op.done;
  }
}
