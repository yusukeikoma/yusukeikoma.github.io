---
title: "Liveness Without Pings, and Idle Sleep"
date: 2026-10-02T16:45:00+09:00
draft: true
tags: ["typescript", "go", "websocket", "heartbeat"]
summary: "A fixed-interval keepalive costs a message in each direction even when the connection is busy. Treating every inbound frame as proof of life, probing only quiet connections, and letting an existing heartbeat tell an idle host when to disconnect removes most of that traffic, at the price of a bounded wake-up delay."
math: false
---

# Liveness Without Pings, and Idle Sleep

Keepalives look like a solved problem until the transport is metered and the client is a phone. Two separate costs hide in them. A fixed-interval ping sends a message each way on a connection that is already carrying traffic and so does not need proving alive. And a connection nobody is looking at still pings, forever, because the process on the far end keeps it open just in case.

This article covers both ends: how a client decides a socket is dead, and how a long-running host decides it does not need a socket at all.

## What a client keepalive is for

A TCP connection that lost its peer without a FIN (a phone that changed networks, a NAT that dropped its mapping, a laptop that slept) looks open to the application until a write fails or a timer fires. The client needs its own timer. The two requirements:

1. Detect a dead peer within a bounded time.
2. Cost as little as possible while the connection is healthy.

Browsers and React Native expose [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), which has no API for sending a protocol-level ping. [RFC 6455 §5.5.2](https://www.rfc-editor.org/rfc/rfc6455#section-5.5.2) defines the Ping control frame, and the peer's stack answers it automatically, but a script cannot emit one. So a script-level liveness check is an *application* message the other side must answer. That is a real message. On a relay where inbound messages are metered ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) it is a billed one.

(If you control the Durable Object, [`setWebSocketAutoResponse`](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) lets it answer a fixed request string without waking from hibernation. That reduces the cost of the answer. It does not make the question free, and it does nothing for a peer that is not a Durable Object.)

## Any frame is proof of life

The design principle is that the only thing a probe proves is that bytes still arrive. A data frame proves that as well as a pong does. So:

- Every frame received, of any kind, resets the quiet timer and clears any outstanding probe.
- A probe is sent only when the connection has been quiet for at least the interval.
- A probe's deadline is measured from the moment it was *sent*, and later ticks never extend it.

The whole policy is a pure function of timestamps, which is what makes it testable without fake timers:

```ts
export type Action = 'wait' | 'ping' | 'close';

/**
 * Called from a fixed-interval tick. Any application frame counts as proof of
 * life, so only a quiet connection is probed, and a probe's deadline is fixed
 * at the moment it was sent.
 */
export function heartbeatAction(
  lastReceivedAt: number,
  pendingPingAt: number | null,
  now: number,
  intervalMs: number,
  timeoutMs: number,
): Action {
  if (pendingPingAt !== null) {
    // A second probe never extends the first one's deadline.
    return now - pendingPingAt >= timeoutMs ? 'close' : 'wait';
  }
  return now - lastReceivedAt >= intervalMs ? 'ping' : 'wait';
}
```

A stream that delivers something every few seconds is never probed, so a busy connection pays nothing. The test for that is deliberately dull: feed frames faster than the interval and assert that zero pings were sent.

### The arithmetic of a tick

The check runs on a fixed-interval tick, and that has a consequence people rarely write down. Suppose the interval is 10 s and the timeout is 25 s (illustrative values, not recommendations). A frame arrives 1 ms after a tick. At the next tick the connection has been quiet for 9.999 s, which is below the interval, so the answer is `wait`. At the tick after that it is 19.999 s, so the answer is `ping`. The probe's 25 s deadline starts then.

The worst-case time from the last frame to a `close` decision is therefore *two intervals plus the timeout*: 45 s with these numbers. If you need a tighter bound, tick more often than the interval; the quiet threshold, not the tick rate, decides when to probe. The test pins this behavior, including the boundary where a probe sent at 20 s closes at exactly 45 s, not 44.999 s:

```ts
test('tick granularity: traffic just after a tick delays the ping, not the deadline', () => {
  const received = 1;
  assert.equal(act(received, null, 10_000, I, T), 'wait'); // only 9.999 s quiet
  assert.equal(act(received, null, 20_000, I, T), 'ping'); // next tick pings
  const pingAt = 20_000;
  for (const now of [30_000, 40_000, 44_999]) assert.equal(act(received, pingAt, now, I, T), 'wait');
  assert.equal(act(received, pingAt, 45_000, I, T), 'close'); // exactly timeout after send
});
```

The `>=` comparison is a decision, too. With a strict `>`, a clock that advances in coarse steps could be one tick late for no reason.

### A late pong is still a pong

The stateful wrapper makes every inbound frame call `onFrame`, which clears the pending probe. A pong that arrives after the deadline but before the next tick, or an ordinary data frame, both rescue the connection. A second tick while a probe is pending does not send another and does not move the deadline.

```ts
export class Heartbeat {
  private lastReceivedAt: number;
  private pendingPingAt: number | null = null;
  constructor(
    private now: () => number,
    private intervalMs: number,
    private timeoutMs: number,
  ) {
    this.lastReceivedAt = now();
  }
  /** Every parsed frame from the peer, not only pongs. */
  onFrame() {
    this.lastReceivedAt = this.now();
    this.pendingPingAt = null;
  }
  /** Run on a setInterval(intervalMs). */
  tick(send: () => void): Action {
    const now = this.now();
    const action = heartbeatAction(this.lastReceivedAt, this.pendingPingAt, now, this.intervalMs, this.timeoutMs);
    if (action === 'ping') {
      this.pendingPingAt = now;
      send();
    }
    return action;
  }
}
```

Two things to adapt in real code. Use a monotonic clock for `now` (`performance.now()`), not wall time, so a clock adjustment cannot fake a timeout. And think about the mobile lifecycle: a JavaScript timer does not run while the app is suspended, so on resume the first tick may find a probe that was sent long ago. In this policy that closes the socket immediately, which is the correct outcome, because a connection that crossed a suspension is more likely dead than alive, and the reconnect path is already built.

## Idle sleep: the connection nobody needs

The other half is a long-running host process, such as an agent on a user's machine, that keeps an outbound WebSocket to the relay so clients can reach it. Most of the day nobody is looking. The connection still exists, still needs keepalives, and still occupies relay resources.

The goal is for the host to hold the connection only while somebody needs it. The mechanism has three requirements.

**A signal that already exists.** The host already calls its control plane on a timer to say it is alive. Make that reply carry one more field: whether a connection is currently needed. Sleeping then adds no polling and no new endpoint, and the same call wakes the host, because the answer simply flips back.

**A three-valued answer.** "Not needed" must be distinguishable from "unknown". In Go that is a pointer:

```go
// HeartbeatReply is what the control plane answers on the heartbeat that
// already exists. Needed is a pointer so an older server that does not send
// the field is distinguishable from one that says "no".
type HeartbeatReply struct {
	Needed *bool
}
```

A server that predates the field omits it, so `Needed` is nil, and the host stays connected as it always did. A failed heartbeat is not evidence that nobody wants the host either, so it also stays connected. Only an explicit "no" disconnects:

```go
// Run keeps a connection only while the control plane says someone needs it.
// The heartbeat doubles as the wake-up call, so sleeping costs no extra traffic.
func Run(ctx context.Context, d Deps) {
	var cur *session
	defer func() {
		if cur != nil {
			cur.stop()
		}
	}()
	ticker := time.NewTicker(d.Every)
	defer ticker.Stop()
	for {
		reply, err := d.Heartbeat(ctx)
		// Unknown stays connected: an old server never sent the field, and a
		// failed heartbeat is not evidence that nobody needs us.
		needed := err != nil || reply.Needed == nil || *reply.Needed
		switch {
		case needed && (cur == nil || !cur.running()):
			if cur != nil {
				cur.stop()
			}
			cur = start(ctx, d.Serve)
		case !needed && cur != nil:
			cur.stop()
			cur = nil
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
```

Cancelling the session context and waiting for the goroutine (`stop` blocks on `done`) means a sleeping host has no connection goroutine left behind. If the connection drops while it is still needed, the next heartbeat restarts it.

```go
func TestOlderServerWithoutTheFieldKeepsTheConnection(t *testing.T) {
	starts, stops := runScript(t, []HeartbeatReply{{}, {}, {}}, nil, 3)
	if starts != 1 || stops != 1 {
		t.Fatalf("starts=%d stops=%d", starts, stops)
	}
}
```

**An honest cost model.** Sleep trades latency for traffic. Work that arrives for a sleeping host waits until the next heartbeat flips the answer and the host reconnects, so the delay is up to one heartbeat interval plus connection setup. Anything that retries against a sleeping host must have a retry window longer than that, or the first request after a quiet period fails when it would have succeeded a moment later. In the real change the retry window had to be extended for exactly this reason.

The sample has no hysteresis. If "needed" flips on every heartbeat you will connect and disconnect on every heartbeat, which is worse than staying connected. A minimum awake time after a wake-up is the usual fix.

## When not to use this

- **The ends speak protocol-level ping/pong.** Between two servers, or two Durable Objects, use the transport's own ping. It is cheaper and needs no application code. This design exists because a browser script cannot send one.
- **Short-lived connections.** If sockets live for seconds, there is nothing to save.
- **First-byte latency is a requirement.** Sleep adds up to a heartbeat of delay to the first request after idle. If that is unacceptable, stay connected and accept the cost.
- **No existing heartbeat to piggyback on.** Adding a poll just to implement sleep spends the savings.

## What I did and did not verify

The heartbeat policy and the sleep loop are covered by unit tests with an injected clock and scripted replies. There was no test of a real connection left idle for a long time, and I did not measure how much traffic this removes. The claims here are structural: a busy connection sends no probes, and a host the control plane says is not needed holds no connection.

## Summary

- A script cannot send a protocol ping, so liveness is an application message; make it rare.
- Treat every inbound frame as proof of life, probe only after a quiet interval, and measure a probe's deadline from when it was sent.
- Worst-case detection is two intervals plus the timeout when ticking at the interval; tick faster to tighten it.
- Let an existing heartbeat carry "is a connection needed", with unknown and errors meaning stay connected.
- Pay for sleeping with a bounded wake-up delay, and size retry windows to cover it.
