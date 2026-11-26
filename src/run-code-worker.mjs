import vm from 'node:vm';

// Runs one normalized async arrow function in a fresh vm context, in a child process the daemon
// starts with Node's permission model on: no file system beyond this file, no child processes, no
// workers, no network, no addons, and an empty environment. The vm context is the first boundary and
// the process is the second, because a vm context is not a security boundary on its own.
//
// The context has no require, process, fetch, module loader or timers: only JavaScript intrinsics,
// plus a `tools` proxy, an `input` value and a `console` shim built inside the context. Only strings
// cross between the context and this process: tool arguments and replies as JSON, log lines, and the
// script's result or error. The script's promise is awaited and its result serialized inside the
// context, so no function of this realm (a resolver, an exception) ever reaches script code: one
// would lead through its constructor to this realm's Function and process.
const pending = new Map();
let nextId = 0;

const send = message => { try { process.send(message); } catch {} };
const isText = value => typeof value === 'string';

// The bridge functions the prelude captures. Each checks its arguments, answers through a callback
// with a string, and never throws: an exception thrown here would be an object of this realm.
function dispatch(name, argsJson, onReply) {
  try {
    if (!isText(name) || !isText(argsJson) || typeof onReply !== 'function') return;
    const id = nextId++;
    pending.set(id, onReply);
    send({ type: 'call', id, name, argsJson });
  } catch {}
}
function emitLog(line) { try { if (isText(line)) send({ type: 'log', line }); } catch {} }
function finish(ok, text) {
  try {
    if (!isText(text)) { ok = false; text = 'The script ended without a readable result.'; }
    send(ok ? { type: 'done', resultJson: text } : { type: 'done', error: text });
  } catch {}
}

// Built inside the context so `tools`, `input` and `console` are context-realm objects. The
// intrinsics it uses are captured before the script runs, so a script that replaces String or JSON
// changes nothing here. A tool call hands the daemon a JSON string, parses the string reply back into
// a context-realm object, and throws an ordinary Error the script can catch when the reply has one.
const prelude = `'use strict';
(() => {
  const dispatch = __dispatch, emitLog = __emitLog, finish = __finish, inputJson = __inputJson;
  delete globalThis.__dispatch; delete globalThis.__emitLog; delete globalThis.__finish; delete globalThis.__inputJson;
  const S = String, parse = JSON.parse, stringify = JSON.stringify, P = Promise, E = Error, T = TypeError;
  const text = value => { try { const s = S(value); return typeof s === 'string' ? s : '[unprintable]'; } catch { return '[unprintable]'; } };
  const line = (prefix, values) => { let out = prefix; for (let i = 0; i < values.length; i++) out += (i ? ' ' : '') + text(values[i]); emitLog(out); };
  const call = (name, argsJson) => new P(resolve => { dispatch(name, argsJson, reply => resolve(typeof reply === 'string' ? reply : '{"error":"The daemon sent no reply."}')); });
  globalThis.input = parse(inputJson);
  globalThis.console = {
    log: (...a) => line('', a), info: (...a) => line('', a), debug: (...a) => line('', a),
    warn: (...a) => line('[warn] ', a), error: (...a) => line('[error] ', a),
  };
  globalThis.tools = new Proxy({}, {
    get: (_, name) => {
      if (typeof name !== 'string') return undefined;
      return async (args) => {
        const reply = parse(await call(name, stringify(args ?? {})));
        if (reply.error) throw new E(reply.error);
        return reply.result;
      };
    },
  });
  // Runs the script and reports its result as a JSON string, or its error as text.
  globalThis.__run = fn => {
    delete globalThis.__run;
    P.resolve().then(fn).then(result => {
      const json = stringify(result ?? null);
      // A function or symbol has no JSON form; say so instead of sending the daemon nothing to parse.
      if (json === undefined) throw new T('The script returned a ' + typeof result + ', which is not JSON. Return plain data.');
      finish(true, json);
    }).catch(error => {
      let message;
      try { message = error !== null && typeof error === 'object' && 'message' in error ? text(error.message) : text(error); } catch { message = 'The script failed.'; }
      finish(false, message);
    });
  };
})();
`;

function start({ code, inputJson }) {
  // No prototype: a plain object literal would give the context's global this realm's
  // Object.prototype, and globalThis.constructor.constructor would be this realm's Function.
  const sandbox = Object.assign(Object.create(null), { __dispatch: dispatch, __emitLog: emitLog, __finish: finish, __inputJson: inputJson ?? 'null' });
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    new vm.Script(prelude).runInContext(context);
    const runner = vm.runInContext('__run', context);
    const fn = new vm.Script(`(${code})`).runInContext(context);
    runner(fn);
  } catch (error) {
    // A syntax error in the script, raised while compiling it here, before any script code ran.
    finish(false, error instanceof Error ? error.message : 'The script could not be compiled.');
  }
}

process.on('message', message => {
  if (message?.type === 'start') { start(message); return; }
  if (message?.type !== 'result') return;
  const onReply = pending.get(message.id);
  if (!onReply) return;
  pending.delete(message.id);
  try { onReply(isText(message.resultJson) ? message.resultJson : '{"error":"The daemon sent no reply."}'); } catch {}
});
