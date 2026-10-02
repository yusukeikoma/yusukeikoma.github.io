---
title: "Resuming Large Streamed Histories: A Folded Cache with a Byte Budget"
date: 2026-10-02T16:25:00+09:00
draft: true
tags: ["typescript", "react-native", "caching", "streaming"]
summary: "A conversation stored as a journal of small events is expensive to reopen. Fold the journal into its final items with a pure function, keep the folded state in a byte-budgeted in-memory LRU, and resume from a sequence cursor with page-size backoff instead of replaying everything."
math: false
---

# Resuming Large Streamed Histories: A Folded Cache with a Byte Budget

A long-running session is stored as a journal: an append-only sequence of small events, each with a sequence number. A model's reply arrives as hundreds of text deltas, and then a final item that supersedes them. To draw the screen you replay the journal and fold it into the list of items the user sees.

Opening the screen for the first time, you have to do that. The second time, you should not. This article is about reopening: showing something immediately, fetching only what is new, and not turning the optimization into a memory problem.

## The trade-offs

A phone that reopens a session by re-reading the whole journal pays three times: it transfers bytes (through a relay that may charge per message and cap frame sizes), it spends CPU folding thousands of events, and the user stares at a blank screen while it does. Candidate fixes:

| Option | What goes wrong |
|---|---|
| Persist the journal on disk | Sensitive content at rest, invalidation when history is rewritten, storage growth, and a migration whenever the event format changes. |
| Persist the folded result | Same privacy and staleness concerns, a smaller footprint. |
| Keep the folded result in memory | Gone when the app quits, bounded by what the OS lets you hold, but no at-rest exposure and no schema to migrate. |
| Ask the server for a snapshot | Best if you control the server; otherwise not an option. |

The design here is the third. Its weakness (memory) is the thing the budget addresses, and its strength (nothing on disk) is why I would reach for it first for conversation content.

## Step 1: fold with a pure function and a cursor

Folding must be a pure function of the previous state and a batch of envelopes, so that it can run in the cache, in the stream handler and in tests with identical results. Three properties matter.

**A cursor.** The result records `lastSeq`, the last envelope folded in. Resume means "everything strictly after this".

**Idempotence on overlap.** Catch-up reads and the live stream will overlap, because you subscribe from a cursor while the last page is still arriving. Envelopes at or below the cursor are skipped, so folding the same tail twice is a no-op. The test asserts exactly that: `fold(f, tail)` deep-equals `f`. This relies on the sequence being strictly increasing within one journal. If your events can arrive out of order, a sequence-number filter would drop valid events and you need a stronger dedupe.

**A reset signal.** If the server rewrites earlier history (a compaction, an edit), the cursor is no longer a valid place to resume from. The journal says so with a `reset` envelope. The fold clears its items and sets a flag, and the cache refuses to keep a reset state. Anything folded before the reset must not be shown again.

```ts
export type Envelope =
  | { seq: number; kind: 'text_delta'; id: string; text: string }
  | { seq: number; kind: 'item'; id: string; text: string }
  | { seq: number; kind: 'reset' };

export interface Folded {
  /** Cursor: the last envelope folded in. Resume reads strictly after it. */
  lastSeq: number;
  items: { id: string; text: string }[];
  /** The server said earlier history was rewritten: nothing here is reusable. */
  reset: boolean;
}

export const emptyFold: Folded = { lastSeq: 0, items: [], reset: false };

/** Pure: thousands of tiny deltas become a few final items. */
export function fold(prev: Folded, envelopes: Envelope[]): Folded {
  let { lastSeq, reset } = prev;
  const items = [...prev.items];
  const index = new Map(items.map((it, i) => [it.id, i]));
  for (const e of envelopes) {
    if (e.seq <= lastSeq) continue; // overlap between catch-up and stream
    lastSeq = e.seq;
    if (e.kind === 'reset') {
      items.length = 0;
      index.clear();
      reset = true;
      continue;
    }
    const at = index.get(e.id);
    if (at === undefined) {
      index.set(e.id, items.length);
      items.push({ id: e.id, text: e.text });
    } else if (e.kind === 'text_delta') {
      items[at] = { id: e.id, text: items[at]!.text + e.text };
    } else {
      items[at] = { id: e.id, text: e.text }; // the final item supersedes its deltas
    }
  }
  return { lastSeq, items, reset };
}
```

The final item replaces its fragments (`items[at] = ...`) rather than appending, so the folded form is a fraction of the journal. On a synthetic journal in the sample (5 items of 50 deltas each) the raw JSON is 15123 characters and the folded items are 1111. That is my test data and it shows only that the folding collapses fragments; it is not a measurement of real sessions.

## Step 2: a cache bounded by bytes, not entries

Sessions differ in size by orders of magnitude. An LRU capped at "N entries" lets a few giant sessions blow past any memory expectation, while a cache capped at a low N wastes space on small ones. Budget in bytes.

```ts
import type { Folded } from './fold.ts';

/**
 * In-memory only: gone when the app quits, never written to disk or to a
 * persisted query cache. Keyed by account scope + session to avoid crossing
 * accounts.
 */
export class FoldCache {
  private entries = new Map<string, { fold: Folded; bytes: number }>();
  private total = 0;

  constructor(private maxBytes: number) {}

  key(scope: string, sessionId: string): string {
    return `${scope}:${sessionId}`;
  }

  get(key: string): Folded | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key); // Map keeps insertion order: delete + set = "most recent"
    this.entries.set(key, e);
    return e.fold;
  }

  set(key: string, fold: Folded): void {
    this.forget(key);
    if (fold.reset || fold.items.length === 0) return; // nothing worth resuming from
    const bytes = JSON.stringify(fold.items).length * 2; // UTF-16: an honest estimate
    if (bytes > this.maxBytes) return; // one entry may not evict everything else
    this.entries.set(key, { fold, bytes });
    this.total += bytes;
    for (const [oldest, e] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest); // first key = least recently used
      this.total -= e.bytes;
    }
  }

  forget(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.total -= e.bytes;
  }

  get size() {
    return this.total;
  }
}
```

Choices in this cache that are easy to get wrong:

- **`Map` as an LRU.** `Map` iterates in insertion order. A read deletes and re-inserts the key, so the first key is always the least recently used, and eviction is "delete from the front until under budget". No linked list needed.
- **Estimate size cheaply and be honest about it.** `JSON.stringify(items).length * 2` approximates UTF-16 text. It ignores object overhead and engine details, so it is an order-of-magnitude figure, good enough to bound a budget and not good enough to account for memory exactly. Set the budget conservatively, and treat it as a limit on retained content.
- **An oversize entry is not stored and evicts nothing.** The alternative, storing it and evicting everything else to make room, means one huge session flushes the cache for every other. The test asserts the cache size is unchanged after an oversize `set`.
- **Reset and empty folds are not kept.** A reset fold has nothing safe to resume from; an empty one resumes nothing. `set` still calls `forget` first, so a reset *replaces* the old entry by removing it. A stale fold lingering under the key would be shown on the next open.
- **The key includes an account scope.** Session identifiers are only unique within an account. A cache keyed by session alone can show one account's content to the next after a switch. The test covers that two scopes with the same session id stay apart. Also clear the cache on sign-out.
- **Memory only.** The content of a session fetched through a relay is deliberately left out of any persisted query cache. A convenient library default that serializes every query result to disk would otherwise write it out.

## Step 3: resume from the cursor

The reopen sequence:

1. Read the cache. If there is a fold, render it at once.
2. Catch up: request the journal strictly after `lastSeq`, a page at a time, folding as you go.
3. Subscribe to the live stream *from the cursor*, not from "now".

Step 3 closes the gap between the last catch-up page and the subscription becoming active: the server replays anything after the cursor, and the sequence filter in `fold` removes the overlap. Subscribing from "now" would lose whatever arrived in between.

Catch-up has one more wrinkle. A page can be too large for the channel: a frame cap on a relay, or an older host that cannot fragment. The reader responds by halving the page size and retrying with the *same* cursor. The cursor never moves backwards, and the loop ends when a page comes back shorter than requested.

```ts
import { fold, type Envelope, type Folded } from './fold.ts';

export class TooLarge extends Error {}

/**
 * Catch up from the cursor, halving the page when a response is too big for the
 * channel, then hand the cursor to the live stream. Returns the folded state.
 */
export async function catchUp(
  start: Folded,
  readPage: (after: number, limit: number) => Promise<Envelope[]>,
  pageSize = 500,
): Promise<Folded> {
  let state = start;
  let limit = pageSize;
  for (;;) {
    const before = state.lastSeq;
    let page: Envelope[];
    try {
      page = await readPage(before, limit);
    } catch (e) {
      if (!(e instanceof TooLarge) || limit === 1) throw e;
      limit = Math.max(1, Math.floor(limit / 2)); // smaller pages, same cursor
      continue;
    }
    state = fold(state, page);
    if (page.length < limit || state.lastSeq === before) return state;
  }
}
```

Two tests cover it. A second reopen reads only what came after the cursor:

```ts
test('resume reads only what came after the cursor', async () => {
  const j = journal(4, 5);
  const seen: Array<[number, number]> = [];
  const read = async (after: number, limit: number) => {
    seen.push([after, limit]);
    return j.filter(e => e.seq > after).slice(0, limit);
  };
  const first = await catchUp(emptyFold, read, 10);
  assert.equal(first.lastSeq, j.length);
  seen.length = 0;
  j.push({ seq: j.length + 1, kind: 'item', id: 'new', text: 'fresh' });
  const second = await catchUp(first, read, 10);
  assert.deepEqual(seen, [[first.lastSeq, 10]]);
  assert.equal(second.items.at(-1)?.id, 'new');
});
```

And under a channel that refuses larger pages, the page size goes 64, 32, 16, 8 while the cursor keeps moving forward:

```ts
test('page size halves on too-large responses and the cursor never moves backwards', async () => {
  const j = journal(3, 8);
  const limits: number[] = [];
  const read = async (after: number, limit: number) => {
    limits.push(limit);
    if (limit > 8) throw new TooLarge();
    return j.filter(e => e.seq > after).slice(0, limit);
  };
  const f = await catchUp(emptyFold, read, 64);
  assert.deepEqual(limits.slice(0, 4), [64, 32, 16, 8]);
  assert.equal(f.lastSeq, j.length);
  assert.equal(f.items.length, 3);
  await assert.rejects(catchUp(emptyFold, async () => { throw new TooLarge(); }, 4), TooLarge);
});
```

## When the fold is written back

The write to the cache should not happen on every delta. The component keeps the fold in its own state and writes it into the cache when it is torn down (an effect cleanup), so the cache always holds the last state the user actually saw. For the live stream, flush envelopes into the fold in a short window instead of per envelope; a reply of hundreds of deltas then costs a handful of renders. The connection itself is a foreground concern: it closes when the app is backgrounded and resumes from the cursor on return, the same path as a reopen.

A cached fold is what you saw, not what is true. It is always an input to catch-up, never a replacement for it.

## When not to use this

- **Histories are small.** If a full re-read is a few kilobytes, a cache and its invalidation rules cost more than they save.
- **Offline reading is a requirement.** In-memory state does not survive a restart. If users must read history without a connection, you need encrypted persistence and the invalidation work that comes with it.
- **The server can hand you a snapshot.** Server-side compaction beats client-side folding, since it saves bytes on the wire as well.
- **Events can arrive out of order, or history is edited in place.** A single monotonic cursor assumes append-only. If that is false, a resume point does not exist.

## What I did and did not verify

The fold, the cache and the catch-up loop are covered by unit tests: overlap, reset, eviction order, oversize and account isolation, page-size halving and cursor monotonicity. I did not measure how much faster reopening is on a device, or how many messages it saves, so I make no claim about either. The size figures above come from a synthetic journal in the test.

## Summary

- Fold the journal with a pure function that keeps a cursor, skips what it has seen, and honors reset.
- Cache folded state in memory under a byte budget; never store reset, empty or oversize folds, and scope keys by account.
- On reopen, show the cache, catch up after the cursor with page-size backoff, then subscribe from the cursor.
- Write the fold back at teardown, and treat it as an input to catch-up, never as the truth.
