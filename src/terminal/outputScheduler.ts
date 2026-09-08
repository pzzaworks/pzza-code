interface OutputChunk {
  bytes: Uint8Array;
  consumed: () => void;
}

interface OutputOptions {
  write: (bytes: Uint8Array, consumed: () => void) => void;
  delay: () => number;
}

// Only one write enters the parser at a time. Transport credit is returned
// after parsing, so batching cannot silently move a backlog into xterm.
export function createOutputScheduler({ write, delay }: OutputOptions) {
  let pending: OutputChunk[] = [];
  let queuedBytes = 0;
  let writing = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (disposed || writing || timer !== undefined || !pending.length) return;
    const wait = delay();
    if (wait === 0) flush();
    else timer = setTimeout(flush, wait);
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || writing || !pending.length) return;
    const chunks = pending;
    const bytes = new Uint8Array(queuedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk.bytes, offset);
      offset += chunk.bytes.byteLength;
    }
    pending = [];
    queuedBytes = 0;
    writing = true;
    let completed = false;
    write(bytes, () => {
      if (completed || disposed) return;
      completed = true;
      writing = false;
      for (const chunk of chunks) chunk.consumed();
      schedule();
    });
  };
  return {
    push(bytes: Uint8Array, consumed: () => void) {
      if (disposed) return;
      pending.push({ bytes, consumed });
      queuedBytes += bytes.byteLength;
      // The transport stops at its credit limit, so hidden tiles can keep
      // their slower cadence even under continuous output.
      schedule();
    },
    flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      pending = [];
      queuedBytes = 0;
    },
  };
}
