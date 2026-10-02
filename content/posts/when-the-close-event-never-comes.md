---
title: "When the Close Event Never Comes"
date: 2026-10-02T16:35:00+09:00
draft: true
tags: ["websocket", "react-native", "typescript", "debugging"]
summary: "A client that waits for its own socket's close event before cleaning up can stall silently when that event never arrives. Settle your state when you decide to end the connection, make the cleanup idempotent, and keep the event for closes you did not start."
math: false
---

# When the Close Event Never Comes

The symptom was easy to describe and hard to find: after a credential was renewed on the far end of a connection, a mobile client stopped receiving replies. No error, no log line, no crash. Reopening the screen fixed it, which is the kind of workaround that hides a bug for a long time.

The cause was one assumption in the client's lifecycle: *the socket will tell me when it is closed, even when I closed it.*

## The failure, step by step

The client held one WebSocket and multiplexed several logical streams over it. Cleanup lived in one place, the socket's `close` event handler:

1. Tell every active stream it has ended (`closed`), so its owner resubscribes.
2. Reject every request that was waiting for a reply.
3. Release the connection object.

When the other side rotated its credentials and ended the streams, the client responded by closing its own socket, as designed, and waited for `close` to run the cleanup. On React Native, in the case that mattered, a socket the application had closed itself never delivered that event. So step 1 never ran, the stream owners were never told, nothing resubscribed, and the replies had nowhere to go. The state looked fine: the connection object existed, the streams were registered, and they simply never received anything again.

I want to be careful about what is established here. In a spec-compliant implementation the `close` event is dispatched when the connection is closed, which for a locally initiated close means after the closing handshake completes or the connection is torn down ([HTML Standard, WebSocket](https://websockets.spec.whatwg.org/#feedback-from-the-protocol); [MDN `close` event](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close_event)). That is not "immediately", and a peer that has vanished can make it a long time. On the specific client runtime, I am relying on the observed behavior and a test that models it, not on a documented guarantee. The design conclusion holds either way.

## The principle: events report, decisions settle

An event handler is the right place to learn about things that happened *to* you: the peer closed, the network dropped, a protocol error. It is the wrong place to record a decision *you* made. A decision should update state at the moment you make it. If you instead make a request ("please close") and wait for a notification that it happened, you have turned your own control flow into something that depends on the delivery of a callback you do not control.

The change is small:

- Move the cleanup into one function, `settle`, that is safe to call any number of times and does its work once.
- Call it from the event handlers, for closes you did not start.
- Call it from `end()`, the one method the client uses whenever *it* decides the connection is over, immediately after asking the socket to close.

```ts
export interface SocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type StreamFrame = { closed: true; error: string } | { data: string };

export class Connection {
  readonly pending = new Map<string, { reject(e: Error): void }>();
  readonly streams = new Map<string, (f: StreamFrame) => void>();
  private settled = false;

  constructor(
    private socket: SocketLike,
    private onListenerError: (e: unknown) => void = e => console.error(e),
  ) {
    // Still the path for closes we did not start: peer, network, server.
    socket.addEventListener('close', this.settle);
    socket.addEventListener('error', this.settle);
  }

  /** Idempotent: every path may call it, only the first does anything. */
  private settle = () => {
    if (this.settled) return;
    this.settled = true;
    // Take the work out of the tables first, then notify. A listener that
    // throws must not stop the others from hearing about it.
    const pending = [...this.pending.values()];
    const streams = [...this.streams.values()];
    this.pending.clear();
    this.streams.clear();
    for (const p of pending) this.guard(() => p.reject(new Error('connection closed')));
    for (const onFrame of streams) this.guard(() => onFrame({ closed: true, error: 'connection closed' }));
  };

  private guard(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.onListenerError(e);
    }
  }

  /**
   * Close the socket ourselves AND settle what rode it, now. The socket's
   * close event is a notification we may or may not get; it is not the
   * source of truth for what we just decided to do.
   */
  end(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } finally {
      this.settle();
    }
  }
}
```

Three details carry the correctness.

**`settle` is idempotent.** The event may still arrive, after `end()`, on a runtime that does deliver it. A second call must be a no-op, or every stream owner is told twice and may resubscribe twice. The test with `FakeSocket(true)` delivers the event late and asserts exactly one notification.

**`finally`, not "after".** `close()` can throw (the specification has it throw for an invalid code or an over-long reason, and a wrapper can throw for its own reasons). If cleanup were sequenced after a throwing call, it would be skipped on exactly the path you are debugging. `try { close } finally { settle }` makes cleanup unconditional, and the exception still propagates to the caller.

**Take work out of the tables before notifying.** Listeners run arbitrary code: a stream owner may react to `closed` by starting a new connection or by registering something. If `settle` iterated the live maps, a listener that touched them would observe a half-cleaned state. Copying the entries out and clearing the tables first means listeners see an empty, finished connection. Each listener also runs in its own `try/catch`. Otherwise one buggy listener that throws turns into the same silent stall for everyone registered after it, and that is the bug in a different shape.

## Reproduce the bug before fixing it

The test double is a socket that can be told never to fire `close`. The first test is the original bug, preserved as an executable statement:

```ts
class FakeSocket implements SocketLike {
  readyState = 1;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(private emitsCloseEvent: boolean) {}
  addEventListener(type: 'close' | 'error', l: () => void) {
    (this.listeners[type] ??= []).push(l);
  }
  close() {
    this.readyState = 3;
    if (this.emitsCloseEvent) queueMicrotask(() => this.listeners['close']?.forEach(l => l()));
  }
  fire(type: 'close' | 'error') {
    this.listeners[type]?.forEach(l => l());
  }
}
```

```ts
test('relying on the event alone loses the frame (the original bug, reproduced)', async () => {
  const sock = new FakeSocket(false);
  const conn = new Connection(sock);
  const frames = subscribe(conn);
  sock.close(); // what the old code did: close and wait for the event
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(frames, []); // nobody was told; nothing resubscribes
});
```

It asserts the wrong behavior on purpose: closing the socket directly and waiting leaves the stream with no frames. Next to it sits the test that fails without the fix and passes with it:

```ts
test('a self-initiated close settles streams even if the socket never fires close', () => {
  const conn = new Connection(new FakeSocket(false));
  const frames = subscribe(conn);
  conn.end(1000, 'renew');
  assert.deepEqual(frames, [{ closed: true, error: 'connection closed' }]);
});
```

The fix is not just "add `end()`". The fix is that every code path that ends a connection goes through it: renewal, expiry, idle timeout, heartbeat timeout, authentication timeout, denial, and malformed frames. A bypass anywhere reintroduces the stall for that cause. It is worth making the raw `socket.close()` impossible to call outside the class, so a future change cannot skip it.

## Why this class of bug survives

Silent stalls are not caught by the usual signals. Nothing throws, no timeout elapses, and any monitor that watches for errors sees a quiet, healthy connection. The state machine has a state ("connected, streams registered") that is *unreachable by design* after a close and yet reachable in practice, and nothing was checking that invariant. Two habits help:

- Write down the invariant: *when a connection ends, every request and stream registered on it is told, exactly once.* Then test that invariant against a socket double that violates each assumption: no close event, a late one, a duplicated one, an error without a close, a `close()` that throws.
- Treat "the owner waits for a notification" as a design smell wherever the notification can be lost. A stream owner that is never told it ended is waiting forever. If you cannot make the notification reliable, give the waiter a deadline.

## When not to use this

- **The cleanup depends on the cause.** If a user-initiated close and a network failure need different handling (for example, only the failure should trigger a reconnect), make `settle` take a reason and let the first cause win. Do not let a late `error` event overwrite a deliberate close.
- **You need to wait for the closing handshake.** If something must happen only after the peer has acknowledged the close, such as releasing a resource the peer holds until it sees the close, you still need the event. Settling early is for your own bookkeeping, not for proof that the peer knows.
- **A new connection reuses the old one's state.** If the replacement is created immediately and shares mutable maps with the old connection, a late event from the old socket can clobber the new state. Keep state per connection object, as in the sample, or ignore events from a socket that is no longer current.

## What I did and did not verify

The behavior is verified against the socket double above: the regression test fails with the event-only version and passes with `end()`. I did not run a long soak on a physical device after the fix, so I do not claim that every renewal over several minutes is now clean on real hardware, only that the cleanup no longer depends on an event that was not arriving.

## Summary

- An event is a poor source of truth for a decision you made yourself; settle your state at the moment you decide.
- One idempotent `settle`, called from both `end()` and the event handlers, handles late, duplicated and missing events.
- Use `try/finally` so cleanup runs when `close()` throws, and detach state before notifying so listeners cannot see a half-cleaned connection.
- Route every code path that ends a connection through `end()`.
- Test the invariant against a double that misbehaves in each way; keep the original failure as a test.
