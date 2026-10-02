---
title: "Batching and Bounded Frames on a Metered Relay"
date: 2026-10-02T16:50:00+09:00
draft: true
tags: ["go", "javascript", "websocket", "durable-objects"]
summary: "When every WebSocket message costs money and every frame has a hard cap, you need batching with independent flush triggers, a single-frame threshold below the cap, bounded chunking, and capability flags that survive mixed-version rollouts. The sharp edges are ordering on shutdown and a zero value that disappears from the wire."
math: false
---

# Batching and Bounded Frames on a Metered Relay

A Go process on a user's machine streams events to browsers and phones through a relay: a JavaScript worker on Cloudflare Durable Objects that keeps one control WebSocket to the machine and forwards frames to clients. Two constraints shape everything that crosses it.

1. **Messages are metered.** On Durable Objects, incoming WebSocket messages are billed (a [20:1 ratio](https://developers.cloudflare.com/durable-objects/platform/pricing/) applies to the request count), outgoing ones are not. A producer that sends one frame per event pays per event.
2. **Frames have a hard cap.** Peers agreed on a maximum frame size. A response bigger than that must be fragmented, and fragmentation needs bounds, or a bad peer can make the reassembler allocate without limit.

Add a third: the worker, the machine process and the browser client are deployed independently. At any moment some of them are old. Any new framing has to be negotiated, not assumed.

This article walks through four mechanisms and the three bugs that were the real lesson.

## 1. Batch events with independent flush triggers

A stream of small events (token deltas, status changes) is the worst case for a per-message meter. The producer can accumulate events and send them as one frame. The trade-off is added latency, which you bound with a window.

Three triggers, any of which flushes:

- **Time:** the window opens with the first event in an empty batch and ends after a short, fixed delay. This is the latency bound.
- **Count:** a maximum number of events per frame, which also bounds what the consumer must validate.
- **Bytes:** a size budget well under the frame cap. If the *next* event would overflow the budget, flush first, then start a new batch with it.

```go
// Frame is one message on the shared control socket.
type Frame struct {
	Type     string  `json:"type"`
	StreamID string  `json:"stream_id"`
	Event    string  `json:"event,omitempty"` // single-event form (older peers)
	Data     string  `json:"data,omitempty"`
	Events   []Event `json:"events,omitempty"` // batched form, 2+ events
}
```

The forwarding loop is where the behavior is. The window, count and byte limits come from a config the caller supplies, and the right values depend on your frame cap and latency budget.

```go
// Forward batches events from in until it closes or ctx ends. Whatever was
// accepted is flushed before returning, on every exit path.
func Forward(ctx context.Context, cfg Config, streamID string, in <-chan Event, write WriteFunc) (err error) {
	var batch []Event
	size := 0
	timer := time.NewTimer(cfg.Window)
	timer.Stop()
	defer timer.Stop()

	flush := func(wctx context.Context) error {
		if len(batch) == 0 {
			return nil
		}
		f := Frame{Type: "stream_data", StreamID: streamID}
		if len(batch) == 1 { // a batch of one stays wire-compatible with old peers
			f.Event, f.Data = batch[0].Name, batch[0].Data
		} else {
			f.Events = batch
		}
		batch, size = nil, 0
		timer.Stop()
		return write(wctx, f)
	}

	// The terminal frame must follow every accepted event, even when ctx has
	// been cancelled. A write on a cancelled context would also tear down the
	// shared socket, so use a detached context with its own deadline.
	defer func() {
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		err = errors.Join(err, flush(wctx))
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if err := flush(context.WithoutCancel(ctx)); err != nil {
				return err
			}
		case ev, ok := <-in:
			if !ok {
				return nil
			}
			n := len(ev.Name) + len(ev.Data)
			if size+n > cfg.MaxBytes { // would overflow: ship what we have first
				if err := flush(context.WithoutCancel(ctx)); err != nil {
					return err
				}
			}
			if len(batch) == 0 {
				timer.Reset(cfg.Window) // the window opens with the first event
			}
			batch = append(batch, ev)
			size += n
			if size >= cfg.MaxBytes || len(batch) >= cfg.MaxEvents {
				if err := flush(context.WithoutCancel(ctx)); err != nil {
					return err
				}
			}
		}
	}
}
```

Three details in that loop are easy to get wrong.

**A batch of one goes out un-batched.** A frame with exactly one event uses the old single-event shape. That keeps it readable by a peer that has never heard of batches, so batching is invisible on quiet streams, and the new shape only appears when there is something to save.

**The window opens with the first event, not on a ticker.** A free-running ticker adds up to a full window of latency to an event arriving right after a tick and wakes the goroutine when nothing is happening. A timer that is reset when the batch goes from empty to non-empty costs nothing while idle.

**The terminal frame must follow every accepted event.** When the stream ends (the source closes, the credential expires, the client cancels), the last thing the consumer should see is the batch you already accepted, then the end-of-stream marker. The deferred flush runs on every exit path. It uses `context.WithoutCancel` plus its own short deadline. That detached context is not decoration. In the WebSocket library used here, a write that observes a cancelled context closes the connection, and this connection is shared by every stream. Flushing on the cancelled context would drop the batch and take the other streams down with it. The regression test cancels with two events pending, then asserts both were delivered in one frame and that the context passed to `write` was not cancelled.

```go
func TestCancelFlushesAcceptedEventsOnADetachedContext(t *testing.T) {
	s := &sink{}
	in := make(chan Event)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Forward(ctx, Config{Window: time.Hour, MaxEvents: 100, MaxBytes: 1 << 20}, "s1", in, s.write)
	}()
	in <- Event{Data: "a"}
	in <- Event{Data: "b"}
	cancel()
	err := <-done
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if len(s.frames) != 1 || len(s.frames[0].Events) != 2 {
		t.Fatalf("accepted events were dropped: %+v", s.frames)
	}
	if s.errs[0] != nil {
		t.Fatalf("flush ran on a cancelled context: %v", s.errs[0])
	}
}
```

## 2. Do not fragment what fits

Fragmenting everything above a small chunk size is the first design that comes to mind, and it is wasteful. Each chunk is a billed message, and medium payloads (a few hundred kilobytes) are common. The better rule is to send one frame whenever it fits under the cap *minus a reserve for the relay's own metadata*, and fragment only above that.

```go
// ShouldChunk keeps medium payloads in one frame: only fragment what cannot
// fit under the hard cap once the relay's own metadata is reserved.
func ShouldChunk(payload, hardCap, reserve int, peerChunks bool) (bool, error) {
	if payload <= hardCap-reserve || !peerChunks {
		if payload > hardCap {
			return false, errors.New("frame too large and peer cannot reassemble")
		}
		return false, nil
	}
	return true, nil
}
```

The last branch matters for mixed versions: a peer that cannot reassemble gets a single frame if it fits under the hard cap, and an error otherwise. It is never sent fragments it would silently drop.

## 3. Bound the reassembler, not just the sender

Fragmentation moves risk to the receiver. The receiver must treat chunks as hostile input. The bounds I enforce per connection: how many chunks one message may have, strictly increasing order starting at zero, the total reassembled bytes, and a deadline measured from the first chunk.

```go
func Split(id string, payload []byte, size int) []Chunk {
	count := (len(payload) + size - 1) / size
	out := make([]Chunk, 0, count)
	for i := 0; i < count; i++ {
		end := min((i+1)*size, len(payload))
		out = append(out, Chunk{ID: id, Index: i, Count: count, Data: payload[i*size : end]})
	}
	return out
}
```

```go
// Assembler enforces bounds per connection: chunk count, strict order,
// reassembled bytes, and a deadline from the first chunk.
type Assembler struct {
	MaxChunks, MaxBytes int
	Deadline            time.Duration
	Now                 func() time.Time

	id      string
	next    int
	buf     []byte
	started time.Time
}
```

The test table covers the cases that bounded-ness is for: it must start at index zero, it must reject a gap, it must reject past the deadline, and it must reject once the byte bound is exceeded.

## 4. Negotiate capabilities and carry them through replay

The new framing is only used when the consumer has said it understands it. The consumer sets `accept_batches` (and, for fragments, `accept_chunks`) in its subscribe request, and a producer that does not know the field ignores it and keeps sending single-event frames. The subtle part is the relay in the middle. It cannot rely on in-memory state, because [Durable Objects hibernate](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), so it persists each subscription with the socket and replays them to the machine when that reconnects. If the stored subscription forgets the consumer's flags, every replay silently downgrades the stream to unbatched frames. Nothing breaks, so nobody notices, and the cost regression is invisible until the bill.

```js
// Worker side (JavaScript on Durable Objects): the peer's capabilities are
// stored with the subscription, so a replay after hibernation or a reconnect
// asks the producer for exactly what the consumer can read.
export function rememberSubscription(attachment, value, limit = 16) {
  const subscriptions = (attachment.subscriptions || []).filter(s => s.requestID !== value.request_id);
  if (subscriptions.length < limit) {
    subscriptions.push({
      requestID: value.request_id,
      path: value.path,
      acceptChunks: value.accept_chunks === true,
      acceptBatches: value.accept_batches === true,
    });
  }
  return { ...attachment, subscriptions };
}

export function replayFrames(attachment, connectionID) {
  return (attachment.subscriptions || []).map(s => ({
    type: 'subscribe',
    connection_id: connectionID,
    request_id: s.requestID,
    path: s.path,
    accept_chunks: s.acceptChunks === true,
    accept_batches: s.acceptBatches === true,
  }));
}
```

The replayed subscribe message carries the flags, so the producer resumes with exactly what the consumer can read. The attachment is also bounded: it is small, and the list of subscriptions has a cap. The consumer validates what it gets before trusting it:

```ts
const MAX_EVENTS = 32;

/** Normalise single and batched frames into an ordered list of events. */
export function streamFrames(message: StreamMessage) {
  const { events } = message;
  if (
    events !== undefined &&
    (!Array.isArray(events) ||
      events.length < 1 ||
      events.length > MAX_EVENTS ||
      events.some(e => !e || typeof e.data !== 'string' || (e.event !== undefined && typeof e.event !== 'string')))
  ) {
    throw new Error('invalid stream batch'); // caller closes the socket
  }
  const list: Array<{ event?: string; data?: string }> = events ?? [message];
  // The terminal flag rides on the frame, so it applies after the last event only.
  return list.map((e, i) => {
    const last = i === list.length - 1;
    return {
      event: e.event,
      data: e.data,
      closed: last && (message.closed ?? false),
      error: last ? (message.error ?? null) : null,
    };
  });
}
```

A malformed batch closes the socket rather than being partially applied. The terminal flag and error apply to the last event of the frame only, which keeps the ordering guarantee from section 1 intact on the receiving side. (An earlier version of this sample stamped the flag on every event of the batch. It type-checked, and the test I wrote for it caught the mistake.)

```ts
test('the terminal flag applies after the last event of a batch only', () => {
  const out = streamFrames({ events: [{ data: 'a' }, { data: 'b' }], closed: true });
  assert.deepEqual(out.map(e => e.closed), [false, true]);
});
```

Rollout order does not matter with this scheme. If any hop predates the flags, they never arrive, the producer never batches, and the consumer's normalizer treats single-event frames as a batch of one.

## The three bugs

**The zero that disappeared.** Fragments carry `chunk_index`. In the first version the Go struct tagged it `omitempty`. For an `int`, `omitempty` drops zero ([`encoding/json`](https://pkg.go.dev/encoding/json#Marshal)), so the first chunk of every fragmented message went out without an index. The browser could not reassemble, and a large payload stayed in a loading state forever. The small ones never hit it, which is why it survived. The fix is a dedicated wire struct with no `omitempty` on index and count, and a test that decodes the raw JSON and asserts the key is present, not one that round-trips through the same struct and cannot see the omission. The test in the sample reproduces the bug with a naive struct and then asserts the fix:

```go
func TestChunkIndexZeroIsOnTheWire(t *testing.T) {
	if wireHasIndex(naiveChunk{ID: "x", Index: 0, Count: 2}) {
		t.Fatal("expected omitempty to drop index 0 (this is the bug)")
	}
	if !wireHasIndex(Chunk{ID: "x", Index: 0, Count: 2}) {
		t.Fatal("explicit tag must keep index 0")
	}
}
```

**Giant payloads on the control channel.** Chunking makes it possible to push an enormous diff through the relay, and that is the wrong lesson to take from it. The better fix for a review screen was to stop sending the payload: list the changed files with metadata only, fetch one file's body on demand, and cap the output of the child process that produces the diff while reading it (kill and reap at the limit) instead of after buffering it all. The channel's capacity is not a license to use it.

**Older hosts.** A host that predates fragmentation answers a too-large read with a `response_too_large` error. Callers that page through history retry with a smaller page. The compatibility path is old and ugly on purpose, and it is the reason the new path can be strict.

## When not to use this

- **Latency-critical single-event streams.** Batching adds up to one window of delay. For input echo, that is a regression.
- **Ordering across streams matters more than cost.** Batches preserve order within a stream. Anything that must interleave across streams in a specific order needs a different design.
- **All peers upgrade atomically.** If you deploy producer, relay and consumer as one unit, skip negotiation. It exists for rollouts, and every flag is something to test.
- **The meter is not the problem.** Batching and chunking are complexity. Do not add them for a transport where messages are free.

## What I did and did not verify

The samples run under `go test -race` (repeated), and the TypeScript and JavaScript parts run under `node:test`. The production change had its own unit tests, including a regression test for the terminal-frame ordering that failed before the fix. I did not verify behavior on the real platform, and I did not measure how many messages the batching saves. What I can say is structural: a producer that previously sent one billed message per event now sends at most one per window, per count, or per byte budget, and a batch adds at most one window of latency.

## Summary

- Batch with three independent triggers (time, count, bytes) and flush before an event that would overflow.
- Send single events unbatched, and keep a single frame whenever it fits under the cap minus a reserve.
- Flush accepted events before the terminal frame on every exit, using a detached, bounded context.
- Bound the reassembler: count, order, bytes, deadline.
- Negotiate with flags that survive replay, so rollouts are order-independent.
- Serialize the zero value explicitly, and test the wire JSON.
