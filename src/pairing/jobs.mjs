// Pairing jobs: the daemon's in-memory record of each wireless pairing it runs. A job outlives the
// MCP session and the stdio process that started it (an MCP client may pool and reap those), so any
// session can read it with pairing_status, and only the daemon ends it.
//
//   starting → advertising → pin → paired → registering → mounting_ddi → ready
//   any state → failed { stage, reason, error, action } or cancelled
//
// One job runs per host at a time: the Bonjour name and pairing listener exist once.
import { randomBytes } from 'node:crypto';
import { stateDir as defaultStateDir, pokiNative } from '../config.mjs';
import { startPairHost, stagePairing, completeWirelessPairing, discardStaging, defaultHostName, advertisingInstruction } from './wireless.mjs';
import { ensureDeveloperImage } from './ddi.mjs';
import { work } from '../work.mjs';
import { nativeRequest as helperRequest, disconnectRemote } from '../remote.mjs';
import { unregisterRemote, registeredTargets } from './registry.mjs';

// A helper request on behalf of a job, stopped by the job's own signal (no tool call owns it).
const jobRequest = (target, request, options, signal) => work.run({ signal, timings: [] }, () => helperRequest(target, request, options));

export const pairingLimitMs = 10 * 60000;
export const retentionMs = 15 * 60000;
const terminal = new Set(['ready', 'failed', 'cancelled']);
export const isTerminal = state => terminal.has(state);

const instructions = {
  starting: () => 'Starting wireless pairing on this computer.',
  advertising: job => `${advertisingInstruction(job.host_name)} Keep the iPhone on the same local network as this computer; wireless first pairing needs iOS 27 or newer.`,
  pin: job => `Type ${job.pin} on the iPhone when it asks for the pairing code, then keep the iPhone unlocked.`,
  paired: () => 'The iPhone accepted the pairing. Saving it on this computer.',
  registering: () => 'Saving the pairing on this computer.',
  mounting_ddi: () => 'Preparing developer services: installing the developer disk image over Wi-Fi. This can take a few minutes; keep the iPhone unlocked and nearby.',
  ready: job => `Paired and ready. Pass device: ${JSON.stringify(job.device?.id)} to the device tools.`,
  cancelled: () => 'Pairing was cancelled. On the iPhone, the "Pair with" entry disappears; nothing was saved.',
};

export class PairingJobs {
  jobs = new Map();
  // now: the clock for start, end and retention times (tests pass their own).
  constructor({ stateDir = defaultStateDir, native = pokiNative, limitMs = pairingLimitMs, retainMs = retentionMs, nativeRequest = jobRequest, inventoryChanged = () => {}, ensureImage = ensureDeveloperImage, now = Date.now, complete = completeWirelessPairing } = {}) {
    Object.assign(this, { stateDir, native, limitMs, retainMs, nativeRequest, inventoryChanged, ensureImage, now, complete });
  }
  running() { return [...this.jobs.values()].filter(job => !isTerminal(job.state)); }
  // The pairing that owns this host's Bonjour name and listener: one at a time.
  pairing() { return this.running().find(job => job.kind !== 'prepare'); }
  busy() { return this.running().length > 0; }
  prune(now = this.now()) {
    for (const [id, job] of this.jobs) if (isTerminal(job.state) && now - job.ended_ms >= this.retainMs) this.jobs.delete(id);
  }
  get(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error(`No pairing job ${JSON.stringify(id)}. Finished jobs are kept for ${Math.round(this.retainMs / 60000)} minutes; call list_devices to see the current ones, or pair_device to start again.`), { code: 'no_job' });
    return job;
  }
  list() { this.prune(); return [...this.jobs.values()].map(view); }
  host() {
    const job = this.pairing();
    return { name: job?.host_name ?? defaultHostName(), advertising: Boolean(job && ['advertising', 'pin'].includes(job.state)) };
  }
  // Starts a pairing, or returns the one already running on this host (there is one Bonjour name).
  // With `device` (a registered RemotePairing target), only prepares that phone again: a phone that
  // no longer offers displayservice needs its developer disk image, not a new pairing. That runs
  // beside a pairing of another phone, and returns the job already working on the same phone.
  start({ name, device } = {}) {
    this.prune();
    const running = device ? this.preparing(device.id) : this.pairing();
    if (running) return { job: view(running), existing: true };
    const id = `pair-${randomBytes(6).toString('hex')}`;
    const job = { id, state: 'starting', host_name: name || defaultHostName(), started_at: new Date(this.now()).toISOString(), started_ms: this.now(), expires_ms: this.now() + this.limitMs, history: [] };
    if (device) Object.assign(job, { kind: 'prepare', device: { id: device.id, name: device.name } });
    this.jobs.set(id, job);
    this.transition(job, 'starting');
    job.done = (device ? this.prepare(job, device) : this.run(job)).catch(error => this.fail(job, 'internal', { reason: 'internal_error', error: error.message, action: 'Retry pair_device. If it fails again, check the Poki MCP log.' }));
    return { job: view(job), existing: false };
  }
  transition(job, state, fields = {}) {
    if (isTerminal(job.state)) return false;
    Object.assign(job, fields, { state, updated_at: new Date().toISOString() });
    job.history.push({ state, at: job.updated_at });
    if (isTerminal(state)) {
      job.ended_ms = this.now();
      clearTimeout(job.timer);
      job.controller?.abort(new DOMException(`Pairing ${state}`, 'AbortError'));
    }
    return true;
  }
  fail(job, stage, failure) { return this.transition(job, 'failed', { stage, ...failure }); }
  // Stops a running job: the helper withdraws its Bonjour service. A pairing the iPhone already
  // accepted (paired, registering) is removed again once its registration finishes, unless the phone
  // was registered before this job; the reply says which.
  async cancel(id) {
    const job = this.get(id);
    if (isTerminal(job.state)) return view(job);
    const child = job.child;
    const saving = ['paired', 'registering'].includes(job.state);
    const note = job.device ? 'The iPhone was already paired and stays paired; developer-service preparation stopped. Use unpair_device to remove it.'
      : saving ? 'The iPhone had already accepted the pairing; it is being removed from this computer again.' : undefined;
    this.transition(job, 'cancelled', note ? { note } : {});
    if (child && child.exitCode === null && child.signalCode === null) await stopChild(child);
    // The registration in flight finishes first, then run() undoes it (and corrects the note).
    if (saving) await Promise.race([job.done, new Promise(resolve => setTimeout(resolve, 10000).unref?.())]);
    return view(job);
  }
  // Stops every job (daemon shutdown).
  async close() { await Promise.allSettled([...this.jobs.values()].filter(job => !isTerminal(job.state)).map(job => this.cancel(job.id))); }
  // Stops the job preparing this device, if one is (unpair_device).
  async cancelForDevice(device) {
    for (const job of this.jobs.values()) if (!isTerminal(job.state) && job.device?.id === device) await this.cancel(job.id);
  }
  preparing(device) { return [...this.jobs.values()].find(job => !isTerminal(job.state) && job.device?.id === device); }

  async run(job) {
    job.controller = new AbortController();
    const staging = await stagePairing({ stateDir: this.stateDir });
    try {
      if (isTerminal(job.state)) return;
      const helper = startPairHost({ name: job.host_name, hostState: staging.hostState, output: staging.pairing, native: this.native });
      job.child = helper.child;
      // Slightly longer than the helper's own limit, which ends it with a timeout event first.
      job.timer = setTimeout(() => { void this.expire(job); }, this.limitMs + 5000);
      job.timer.unref?.();
      helper.events.on('advertising', event => this.transition(job, 'advertising', { port: event.port }));
      helper.events.on('connected', event => { job.peer = event.peer; });
      helper.events.on('pin', event => this.transition(job, 'pin', { pin: String(event.pin) }));
      helper.events.on('timeout', () => { job.timed_out = true; });
      let result;
      try { result = await helper.done; }
      catch (error) {
        if (job.state === 'cancelled') return;
        if (job.timed_out) return this.timeout(job);
        return this.fail(job, 'pairing', error.spawnError
          ? { reason: 'helper_missing', error: error.message, action: 'Run ./bin/setup on this computer to build build/poki-native, then pair again.' }
          : { reason: 'pairing_failed', error: error.message, action: 'Keep the iPhone unlocked on the same local network, open Settings › Privacy & Security › Developer Mode again, and retry pair_device. Wireless first pairing needs iOS 27 or newer.' });
      }
      if (isTerminal(job.state)) return;
      this.transition(job, 'paired', { pin: undefined, paired_device: result.device });
      this.transition(job, 'registering');
      // A phone paired again (a new address, or its trust was cleared) may still have a helper
      // running from before, holding the old address and record: stop it, so the next call starts
      // one with the new configuration.
      const previous = (await registeredTargets({ stateDir: this.stateDir }).catch(() => [])).find(d => d.id === result.device?.udid);
      if (previous) await disconnectRemote(previous).catch(() => {});
      let device;
      try { device = await this.complete(result, { pairing: staging.pairing, stateDir: this.stateDir }); }
      catch (error) { return this.fail(job, 'registering', { reason: 'registration_failed', error: error.message, action: 'Pass the iPhone\'s .local name or LAN address: run node bin/prepare-remote.mjs --wireless HOST on this computer.' }); }
      if (job.state === 'cancelled') {
        if (previous) job.note = 'The iPhone had already accepted the pairing. It was registered on this computer before this job, so it stays registered with the new pairing. Use unpair_device to remove it.';
        else { await unregisterRemote(device.id, { stateDir: this.stateDir }).catch(() => {}); job.note = 'The iPhone had already accepted the pairing; it was removed from this computer again.'; }
        this.inventoryChanged(device.id);
        return;
      }
      job.device = { id: device.id, name: device.name, host: device.host, model: device.model };
      this.inventoryChanged(device.id);
      if (isTerminal(job.state)) return;
      clearTimeout(job.timer);
      await this.mount(job, { id: device.id, name: device.name, kind: 'physical', connection: 'RemotePairing', remote: device.config_path });
    } finally {
      clearTimeout(job.timer);
      await discardStaging(staging.directory).catch(() => {});
    }
  }
  async prepare(job, target) {
    job.controller = new AbortController();
    await this.mount(job, target);
  }
  // The last step: the developer disk image over the tunnel (ddi.mjs).
  async mount(job, target) {
    if (!this.transition(job, 'mounting_ddi')) return;
    // The installation releases the device's input session and holds its helper for minutes: it
    // takes the device's input lock, so other sessions' input waits instead of colliding with it.
    let release;
    try { release = await this.coordinator?.inputLock.acquire([target.id], { session: `pairing job ${job.id}`, tool: 'pair_device' }, job.controller.signal); }
    catch (error) {
      if (job.state !== 'cancelled') this.fail(job, 'ddi', { reason: 'device_busy', error: error.message, action: `Another session is using ${target.id}. Call pair_device with device ${JSON.stringify(target.id)} again once it is done.`, paired: true });
      return;
    }
    try {
      const prepared = await this.ensureImage(target.id, (request, options) => this.nativeRequest(target, request, options, job.controller.signal), { signal: job.controller.signal });
      this.transition(job, 'ready', { ddi: { ready: true, already_mounted: prepared.already, ...(prepared.ddi?.version ? { version: prepared.ddi.version } : {}), ...(prepared.source ? { source: prepared.source } : {}) } });
    } catch (error) {
      if (job.state === 'cancelled') return;
      const failure = error.failure ?? { reason: 'ddi_tunnel_install_failed', error: error.message, action: `Keep the iPhone unlocked on the same network and call pair_device with device ${JSON.stringify(target.id)} to try again, or connect it by USB once and run node bin/prepare-device.mjs ${target.id}.` };
      this.fail(job, 'ddi', { ...failure, paired: true });
    } finally { release?.(); }
  }
  timeout(job) {
    return this.fail(job, 'pairing', { reason: 'timeout', error: `Pairing was not finished on the iPhone within ${Math.round(this.limitMs / 60000)} minutes.`, action: 'Call pair_device again and finish the steps on the iPhone within 10 minutes.' });
  }
  async expire(job) {
    if (isTerminal(job.state) || job.device) return;
    const child = job.child;
    this.timeout(job);
    if (child && child.exitCode === null && child.signalCode === null) await stopChild(child);
  }
}

function stopChild(child) {
  return new Promise(resolve => {
    child.once('close', resolve);
    child.kill('SIGTERM');
    const escalation = setTimeout(() => child.kill('SIGKILL'), 3000);
    escalation.unref?.();
    child.once('close', () => clearTimeout(escalation));
  });
}

// What a tool reports about a job: no child process, timers or abort controllers.
export function view(job) {
  const instruction = (instructions[job.state] ?? (() => undefined))(job);
  return {
    job: job.id, kind: job.kind ?? 'pair', state: job.state, host_name: job.host_name,
    ...(job.pin && job.state === 'pin' ? { pin: job.pin } : {}),
    ...(job.device ? { device: job.device } : {}),
    ...(job.ddi ? { ddi: job.ddi } : {}),
    ...(job.state === 'failed' ? { stage: job.stage, reason: job.reason, error: job.error, action: job.action, ...(job.paired ? { paired: true } : {}) } : {}),
    ...(job.note ? { note: job.note } : {}),
    instruction: job.state === 'failed' ? job.action : instruction,
    started_at: job.started_at, updated_at: job.updated_at,
    expires_at: isTerminal(job.state) ? undefined : new Date(job.expires_ms).toISOString(),
    terminal: isTerminal(job.state),
  };
}

// One readable line per job, for clients that show only text (no MCP Apps).
export function describe(job) {
  const where = job.device ? ` (${job.device.name}, ${job.device.id})` : '';
  switch (job.state) {
    case 'pin': return `PIN: ${job.pin}. Type it on the iPhone in Settings › Privacy & Security › Developer Mode. Job ${job.job}.`;
    case 'failed': return `Pairing failed${where}: ${job.error ?? job.reason}. ${job.action ?? ''} Job ${job.job}.`.replace(/\s+/g, ' ').trim();
    default: return `${job.instruction} Job ${job.job}, state ${job.state}${where}.`;
  }
}

// The daemon's jobs. Every session reads the same ones.
export const pairingJobs = new PairingJobs();
