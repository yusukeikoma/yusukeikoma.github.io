---
title: "Idempotent Send: Lost Acks, One Replay, and Backoff"
date: 2026-10-02T16:30:00+09:00
draft: true
tags: ["typescript", "idempotency", "reliability", "mobile"]
summary: "When a send times out you cannot tell whether the request was lost or only its acknowledgement was. A client-generated nonce, a read-by-nonce confirmation, a single replay after sustained absence, and a backoff on the confirming reads give you effectively-once delivery without a reliable queue."
math: false
---

# Idempotent Send: Lost Acks, One Replay, and Backoff

A phone sends a message through a relay to a process on another machine. The request goes over a mobile network, through at least two hops, and the answer comes back the same way. The send times out. What now?

The honest answer is that the client does not know. Either the request never arrived, or it arrived and the acknowledgement was lost. These two cases look identical from the sender's side, and they need opposite responses: the first needs a resend, the second must not get one.

## The trade-offs of the obvious options

| Strategy | Failure |
|---|---|
| Never retry | A lost request is a lost message. The user retypes it. |
| Retry blindly | A lost ack becomes a duplicate. The user's instruction runs twice. |
| Show an error and let the user decide | The user cannot know either, and often picks "send again" anyway. |

What you want is *effectively once*: at-least-once delivery combined with a receiver that treats a repeated request as the same request. Idempotency keys are the standard tool ([the IETF draft for an `Idempotency-Key` header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) describes the common shape; [Stripe's documentation](https://docs.stripe.com/api/idempotent_requests) is a widely used example). The interesting part is not the key. It is what the client does *around* it.

## The mechanism: a nonce and a way to ask

Two ingredients:

1. **A nonce generated once per user intent**, before the first send, and stored with the pending message. Every replay is byte-identical, carrying the same nonce. The receiver dedupes on it.
2. **A read-by-nonce endpoint.** The client can ask "what happened to the operation with this nonce?" without sending the payload again.

With those, an ambiguous send turns into a question the system can answer. Instead of "should I resend?", the client asks "did it arrive?". Replay is the last resort, not the first reflex.

If the app can be killed between creating the intent and getting an answer, the nonce and payload must be persisted (an outbox). A nonce that existed only in memory dies with the process, and with it the ability to ask.

## The decision procedure

```ts
export class CallError extends Error {
  constructor(public status: number, public code: string) {
    super(`${status} ${code}`);
  }
}
```

```ts
/** A definite answer from the server: stop, do not poll, do not replay. */
const refused = (e: unknown) => e instanceof CallError && e.status >= 400 && e.status < 500 && e.status !== 404;

export async function deliver<O extends Operation>(o: Options<O>): Promise<O> {
  const neverLandedMs = o.neverLandedMs ?? 10_000;
  const deadline = o.now() + (o.timeoutMs ?? 30_000);
  let wait = o.pollMs ?? 150;
  const waitMax = o.pollMaxMs ?? 1_000;

  let op: O | undefined;
  try {
    op = await o.start();
  } catch (e) {
    if (refused(e)) throw e; // ambiguity only: a lost ack looks like a timeout, not a 4xx
  }

  let absentSince: number | null = null;
  let replayed = false;
  while ((!op || op.state === 'preparing') && o.now() < deadline) {
    await o.sleep(wait);
    wait = Math.min(wait * 1.5, waitMax); // each read costs a billed round trip
    try {
      op = await o.fetch();
      absentSince = null;
    } catch (e) {
      const absent = e instanceof CallError && e.status === 404 && e.code === 'not_found';
      if (!absent) {
        absentSince = null; // unreachable proves nothing about whether it arrived
        continue;
      }
      absentSince ??= o.now();
      if (o.now() - absentSince < neverLandedMs) continue;
      if (replayed) throw new Error('never received'); // second absence: give up
      replayed = true;
      absentSince = null;
      try {
        op = await o.start(); // replay exactly once, same nonce
      } catch (re) {
        if (refused(re)) throw re;
      }
    }
  }
  if (!op) throw new Error('acceptance still unknown');
  if (op.state === 'failed') throw new Error('failed to start');
  // A queued receipt is durable delivery. Waiting for execution would report
  // every message held behind a running turn as lost.
  if (op.state === 'preparing') throw new Error('not confirmed in time');
  return op;
}
```

The loop in `deliver` encodes six rules. Each one exists because the simpler version has a failure.

**1. A definite refusal stops everything.** A 4xx from a reachable server is an answer. Ambiguity only comes from not receiving one: a timeout, a dropped connection, a 5xx. Treating a refusal as ambiguity makes the client poll for something that will never exist and replay a request that will be refused again. The one exception is a 404 on the *read*, covered next.

**2. Ambiguity is resolved by reading, not by resending.** The first thing to do after an unclear `start` is `fetch` by nonce. If the operation is there, in any state past "preparing", the ack was lost and nothing else needs doing. The test "lost ack" asserts the request was sent exactly once.

**3. Absence must be sustained, and from a reachable server, before replaying.** A "not found" on the first read proves little: the original request may still be somewhere in the pipeline and about to land. If you replay now, two copies race, and even if the receiver dedupes by nonce, the replay can overtake a later message and change ordering. So the loop requires `not_found` to be *continuous* for a window (a parameter; ten seconds in the sample, an illustrative value). Any other outcome of a read resets the absence timer, because a read that failed to reach the server says nothing about whether the original did:

```ts
test('unreachable reads never count as absence', async () => {
  const c = clock();
  let reads = 0;
  let starts = 0;
  await assert.rejects(
    deliver({
      ...c,
      timeoutMs: 60_000,
      start: async () => {
        starts++;
        throw new Error('timeout');
      },
      fetch: async () => {
        reads++;
        throw new Error('socket down');
      },
    }),
    /acceptance still unknown/,
  );
  assert.equal(starts, 1);
  assert.ok(reads > 10);
});
```

The window is a real trade-off. Longer means a genuinely lost message is noticed later. Shorter raises the chance of racing a slow original. It also has a server-side corollary: the receiver's dedupe record must outlive the client's whole retry horizon (timeout plus replay window), or the replay will be treated as new.

**4. Replay once.** After the window, send the same request again. If the next window of reads also finds nothing, fail. A loop that replays forever turns a persistent fault into a request storm, and the user is better served by an error they can act on.

```ts
test('absent twice: fail instead of replaying forever', async () => {
  const c = clock();
  let starts = 0;
  await assert.rejects(
    deliver({
      ...c,
      timeoutMs: 120_000,
      start: async () => {
        starts++;
        throw new Error('timeout');
      },
      fetch: async () => {
        throw new CallError(404, 'not_found');
      },
    }),
    /never received/,
  );
  assert.equal(starts, 2);
});
```

**5. Success means accepted, not executed.** The receiver may be busy with a previous turn and put the new message in a queue. A `queued` receipt is durable delivery: the system has taken responsibility. Waiting for execution would report every message held behind a long-running job as lost. Define the terminal states you wait for by asking what you promised the user.

**6. The deadline bounds everything.** A total timeout caps the loop; if acceptance is still unknown at the end, the error says that, rather than claiming the message was lost.

## Refuse early, with a type

The refusal rule only works if refusals are *typed*. This was the quieter bug in the original code. When a payload exceeded the size limit, the failure surfaced as a plain untyped error. The delivery loop could not tell it from a network timeout, so it did what it does for ambiguity: it polled, waited out the absence window, replayed, and eventually reported a misleading transport error, for a request that could never have succeeded.

The cure is to classify at the source. Check what you can check locally, before sending, and throw a typed error that the loop recognizes as definite:

```ts
import { CallError } from './deliver.ts';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Refuse locally what the far side cannot or will not take. These are
 * definite answers, so they are typed errors: the delivery loop must stop on
 * them instead of treating them as "unknown, go and check".
 */
export function precheck(
  body: string,
  limits: { maxBytes: number },
  required: readonly string[],
  advertised: ReadonlySet<string>,
): void {
  if (bytes(body) > limits.maxBytes) throw new CallError(413, 'too_large');
  const missing = required.filter(f => !advertised.has(f));
  // An older host would ignore a field it does not know and "succeed" without
  // doing what the user asked. Say no before sending.
  if (missing.length > 0) throw new CallError(422, 'unsupported_feature');
}
```

Two details. Measure size in bytes, not characters, since the limit applies to what goes over the wire (the test uses a multi-byte string to prove it). And check required capabilities against what the remote side advertised. An older receiver that does not know a field typically ignores it, which means a message "succeeds" while silently not doing what was requested. A refusal is better than a quiet downgrade.

```ts
test('a typed refusal from start() ends the loop with no reads', async () => {
  let reads = 0;
  let t = 0;
  await assert.rejects(
    deliver({
      now: () => t,
      sleep: async ms => void (t += ms),
      start: async () => {
        precheck('x'.repeat(20), { maxBytes: 10 }, [], caps);
        return { state: 'queued' as const };
      },
      fetch: async () => {
        reads++;
        return { state: 'queued' as const };
      },
    }),
    /413/,
  );
  assert.equal(reads, 0);
});
```

## Backoff on the confirming reads

The confirming reads are not free. On a metered relay each one is a billed message, and on a phone each one wakes the radio. A fixed short interval is ideal for the common case, where the answer arrives in a few hundred milliseconds, and wasteful for the tail, where you wait many seconds to learn the original was lost.

The loop therefore grows its interval geometrically up to a cap. The sample starts at 150 ms, multiplies by 1.5, and caps at one second; those are illustrative values. The arithmetic for a 20-second wait, from a function in the sample and not a measurement of any real system:

```ts
test('backoff: wait grows geometrically to a cap and cuts the number of reads', () => {
  const fixed = Math.floor(20_000 / 150); // fixed 150 ms for a 20 s wait
  const grown = schedule(150, 1.5, 1_000, 20_000);
  assert.deepEqual(grown.slice(0, 4), [150, 225, 337.5, 506.25]);
  assert.equal(Math.max(...grown), 1_000);
  assert.ok(grown.length < fixed / 3, `${grown.length} vs ${fixed}`);
  console.log(`# reads over a 20 s wait: fixed 150 ms = ${fixed}, backoff = ${grown.length}`);
});
```

Fixed 150 ms gives 133 reads; this schedule gives 23. The cost is that the outcome can be noticed up to one cap-length later than it happened, so the success or error display can lag by up to that interval. That is the trade, and it is why the cap is small. A longer cap saves more reads and makes the UI feel slower.

## When not to use this

- **The operation is not idempotent and the receiver does not dedupe.** Without a server that honors the nonce, a replay is a duplicate. Do not replay; ask the user.
- **You already have a durable queue between the endpoints.** If the transport itself provides acknowledgement and redelivery, a second layer of confirmation is redundant complexity.
- **A duplicate is harmless and an error is not.** Some operations (setting a value, marking as read) are naturally idempotent. A plain retry is fine and simpler.
- **The read path is as unreliable as the write path.** If you cannot reach the server to read, you learn nothing, and the loop will run to its deadline. That is acceptable only if the deadline is short enough to give the user an answer.

## What I did and did not verify

The loop, the guard, and the schedule are covered by unit tests with an injected clock and scripted server behavior, including the lost-ack, never-landed, absent-twice, unreachable-read, refusal, and queued cases. I did not measure the effect of the backoff in production; the numbers above are arithmetic over the schedule.

## Summary

- A timeout is ambiguous. Generate a nonce per intent, persist it, and make every replay identical.
- Resolve ambiguity by reading by nonce, not by resending.
- Replay only after sustained absence from a server you could reach, replay once, then fail.
- Make refusals typed and check them locally, in bytes, before sending; a refusal must never look like ambiguity.
- Count acceptance (`queued`) as delivery, and grow the read interval to a small cap.
