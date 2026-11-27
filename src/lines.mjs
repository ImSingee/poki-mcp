import { createInterface } from 'node:readline';

// A line reader over a socket or a child's output. readline re-emits its input's errors on itself,
// and an error with no listener ends the process: one ECONNRESET from a native helper that died with
// a request unread took the whole daemon down, with every client's session. The input's own error
// and close handlers decide what a failure means; this listener only keeps it from being fatal.
export function lines(input) {
  const reader = createInterface({ input });
  reader.on('error', () => {});
  return reader;
}
