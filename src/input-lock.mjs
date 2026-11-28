// Scheduling for a daemon shared by several sessions and devices.
//
// One phone has one screen, so a tool that changes it holds that device's lock for the whole call.
// Different devices run side by side. Read-only tools take no device lock and run beside another
// session's input, capped by POKI_MAX_CONCURRENT_READS. A call that cannot get its lock within
// POKI_INPUT_LOCK_WAIT_MS fails with an error that names the holder. run_code holds every device
// it names, all at once, so two scripts that name the same devices cannot each wait for the other.
//
// The lock lives in this process. Two daemons driving one phone are not supported.

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function inputLockFromEnv(env = process.env) {
  return new InputLock({
    waitMs: positiveInteger(env.POKI_INPUT_LOCK_WAIT_MS, 30000, 'POKI_INPUT_LOCK_WAIT_MS'),
    maxReads: Math.max(1, positiveInteger(env.POKI_MAX_CONCURRENT_READS, 4, 'POKI_MAX_CONCURRENT_READS')),
  });
}

export class InputLock {
  holders = new Map(); waiters = new Set(); reads = 0; readWaiters = [];
  constructor({ waitMs = 30000, maxReads = 4 } = {}) { this.waitMs = waitMs; this.maxReads = maxReads; }

  free(keys) { return keys.every(key => !this.holders.has(key)); }

  // Takes every key at once. Resolves to a release function; rejects with the holder named after
  // waitMs (the lock's own, or a shorter one for this call), or when signal aborts. No keys (a call
  // that names no device) takes nothing.
  acquire(keys, holder, signal, { waitMs = this.waitMs } = {}) {
    keys = [...new Set(keys)].sort();
    if (signal?.aborted) return Promise.reject(signal.reason);
    const take = () => {
      const entry = { ...holder, since: performance.now() };
      for (const key of keys) this.holders.set(key, entry);
      return () => { for (const key of keys) if (this.holders.get(key) === entry) this.holders.delete(key); this.wake(); };
    };
    if (this.free(keys) && ![...this.waiters].some(waiter => waiter.keys.some(key => keys.includes(key)))) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const waiter = { keys, ready: () => { finish(); resolve(take()); } };
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { finish(); reject(signal.reason); this.wake(); };
      const timer = setTimeout(() => { finish(); reject(this.busy(keys, waitMs)); this.wake(); }, waitMs);
      timer.unref?.();
      signal?.addEventListener('abort', aborted, { once: true });
      this.waiters.add(waiter);
      this.wake();
    });
  }

  // First come, first served among waiters whose devices are free; a waiter for a busy device does
  // not hold up a waiter for another device.
  wake() {
    const claimed = new Set();
    for (const waiter of [...this.waiters]) {
      if (!waiter.keys.some(key => claimed.has(key)) && this.free(waiter.keys)) waiter.ready();
      else for (const key of waiter.keys) claimed.add(key);
    }
  }

  busy(keys, waitMs = this.waitMs) {
    const key = keys.find(key => this.holders.has(key)) ?? keys[0];
    const holder = this.holders.get(key);
    const who = holder ? ` Session ${holder.session ?? 'unknown'} is running ${holder.tool} (held ${Math.round(performance.now() - holder.since)} ms).` : '';
    return Object.assign(new Error(`Device ${key} is busy with input from another call.${who} Waited ${waitMs} ms; retry when it finishes.`), { name: 'InputLockTimeout' });
  }

  readSlot(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.reads < this.maxReads) { this.reads++; return Promise.resolve(() => this.releaseRead()); }
    return new Promise((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', aborted); this.reads++; resolve(() => this.releaseRead()); };
      const aborted = () => { this.readWaiters = this.readWaiters.filter(w => w !== waiter); reject(signal.reason); };
      signal?.addEventListener('abort', aborted, { once: true });
      this.readWaiters.push(waiter);
    });
  }
  releaseRead() { this.reads--; this.readWaiters.shift()?.(); }
}
