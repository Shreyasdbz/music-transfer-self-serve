// Shared SSE helper for the EventEmitter-backed streams (operations, preflight,
// catalog). Wraps Hono's streamSSE with: a SERIALIZED writer (so rapid emitter
// events can't interleave bytes), a terminal `done()` signal, and abort cleanup.
// The connection stays open until done() is called (terminal event) or the
// client disconnects.

import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

export interface SseFrame {
  /** Numeric `seq` for Last-Event-ID replay; omit for transient frames. */
  id?: string;
  event: string;
  /** Pre-serialized payload (already JSON.stringify'd). */
  data: string;
}

export interface SseApi {
  /** Queue a frame (serialized; no-op after close). */
  write(frame: SseFrame): void;
  /** Signal the terminal event — closes the stream after pending writes flush. */
  done(): void;
  /** Register a cleanup callback (e.g. emitter.off) run on close/abort. */
  onClose(cb: () => void): void;
}

/** Run an SSE stream. `setup` subscribes to the live source, replays persisted
 * events, and calls `done()` when the stream should terminate (or never, for a
 * long-lived idle stream that closes only on client disconnect). */
export function sse(c: Context, setup: (api: SseApi) => void | Promise<void>): Response {
  c.header("X-Content-Type-Options", "nosniff");
  return streamSSE(c, async (stream) => {
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((r) => (resolveDone = r));
    const closers: (() => void)[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    let closed = false;

    const done = (): void => {
      if (closed) return;
      closed = true;
      resolveDone();
    };

    const api: SseApi = {
      write(frame) {
        if (closed) return;
        // Serialize writes through a promise chain so frames never interleave.
        chain = chain.then(() => stream.writeSSE(frame)).catch(() => undefined);
      },
      done,
      onClose(cb) {
        closers.push(cb);
      },
    };

    stream.onAbort(() => done());

    await setup(api);
    await donePromise;
    for (const cb of closers) {
      try {
        cb();
      } catch {
        /* ignore cleanup errors */
      }
    }
    await chain; // flush any queued writes before the stream closes
  });
}
