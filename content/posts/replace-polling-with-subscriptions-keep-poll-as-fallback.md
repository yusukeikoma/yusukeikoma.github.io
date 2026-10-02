---
title: "Replace Polling with Change Subscriptions, and Keep the Poll as the Fallback"
date: 2026-10-02T17:00:00+09:00
draft: true
tags: ["typescript", "websocket", "react-native", "realtime"]
summary: "How a mobile client moved from timer-driven polling to shared change subscriptions over a per-message-billed relay. The subtle part is not the stream. It is deciding honestly when the fallback poll may stand down."
math: false
---

# Replace Polling with Change Subscriptions, and Keep the Poll as the Fallback

A mobile client talks to a long-running process on a remote machine through a relay. The relay is a thin Cloudflare Durable Objects worker: it holds a WebSocket to the machine and a WebSocket to each client, and forwards messages. Several screens need to know "what changed". The first implementation answered that with timers: re-read the conversation list every few seconds, re-ask a control plane whether the machine is online every few more, and re-read a working-copy diff each time the user switched tabs.

That works, and it is the right first implementation. It stops being right when the transport meters you per message.

## The cost model, and what it forces

On Durable Objects, incoming WebSocket messages count toward billing and outgoing ones do not ([pricing docs](https://developers.cloudflare.com/durable-objects/platform/pricing/)). A poll through a relay is a request from the client and a response from the machine, so it is two incoming messages. A poll every `T` seconds on one open screen is therefore `7200 / T` messages per hour, for a screen the user may simply be leaving open on a desk. Each incoming message also runs the object's handler, so steady polling keeps the object from hibernating (see the [WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

I did not measure the saving on real devices. Everything below is arithmetic about scheduled requests that no longer exist, not an observed percentage.

The obvious replacement is a change subscription: the machine already knows when a conversation mutates, so it can push `upsert` events instead of being asked. Three trade-offs decide whether that replacement is actually better:

- **Correctness of "live".** If the poll is removed whenever a stream exists, then a stream that exists but is silent turns a latency problem into a correctness problem.
- **Sharing.** Five hooks that each open their own stream is worse than five polls.
- **What the stream is evidence of.** A stream can sometimes stand in for a second signal (here, presence), but only if you can say why.

## Mechanism: one shared stream per key, with an honest `live` flag

One stream per key, shared by reference count. The stream sends one snapshot and then an upsert per mutation. Consumers get `{ live, items }`. `live` is the only thing the fallback poll is allowed to look at.

```ts
export interface Item {
  id: string;
  updatedAt: string;
}

export interface FeedState<T extends Item> {
  /** The stream has delivered data, so the fallback poll may stand down. */
  live: boolean;
  /** Last known list, newest first. null until the first snapshot. */
  items: T[] | null;
}

export interface Handlers<T extends Item> {
  snapshot(items: T[]): void;
  upsert(item: T): void;
  closed(): void;
}
/** Opens the stream; resolves to a function that stops it. */
export type Open<T extends Item> = (h: Handlers<T>) => Promise<() => void>;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const HEALTHY_MS = 30_000;
```

The feed itself is a small state machine. The three details that matter are in `publish`, `connect`, and the `closed` handler.

```ts
class Feed<T extends Item> {
  state: FeedState<T> = { live: false, items: null };
  refs = 0;
  listeners = new Set<(s: FeedState<T>) => void>();
  private byId = new Map<string, T>();
  private stopStream: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private openedAt = 0;
  private disposed = false;

  constructor(private open: Open<T>) {
    this.connect();
  }

  private publish(live: boolean) {
    // The last known list outlives a drop: stale rows beat an empty pane,
    // and the fallback poll refreshes them while `live` is false.
    const items =
      this.byId.size === 0 && this.state.items === null
        ? null
        : [...this.byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.state = { live, items };
    for (const listener of this.listeners) listener(this.state);
  }

  private connect() {
    let ended = false;
    const drop = () => {
      if (ended || this.disposed) return;
      ended = true;
      this.stopStream = null;
      // A connection that stayed healthy earns a fresh backoff.
      if (this.openedAt && Date.now() - this.openedAt >= HEALTHY_MS) this.attempts = 0;
      this.openedAt = 0;
      this.publish(false);
      const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempts, RETRY_MAX_MS);
      this.attempts += 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, delay);
    };
    this.open({
      // `live` is published by the first frame, never by "the socket opened".
      snapshot: items => {
        if (ended || this.disposed) return;
        this.byId = new Map(items.map(i => [i.id, i]));
        this.publish(true);
      },
      upsert: item => {
        if (ended || this.disposed) return;
        this.byId.set(item.id, item);
        this.publish(true);
      },
      closed: drop,
    }).then(
      stop => {
        if (ended || this.disposed) return stop();
        this.stopStream = stop;
        this.openedAt = Date.now();
      },
      drop, // failing to open is a drop like any other
    );
  }

  dispose() {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopStream?.();
  }
}
```

**`live` comes from the first frame, never from the open.** `open()` resolving only tells you a subscription was accepted. The relay can accept it while the machine never answers, or a proxy can buffer it. If `live` flipped at open, a stream that opens and never delivers would silence the fallback poll permanently. Publishing `live` from the snapshot makes "live" mean "data arrived", which is the only property the fallback cares about.

**The last known list survives a drop.** Stale rows beat an empty pane. While `live` is false the fallback refreshes them. The code keeps `byId` across `drop()` for that reason.

**Backoff resets only after a connection proved healthy.** Resetting the attempt counter on every successful open lets a flapping connection retry at the minimum delay forever. Here the counter resets when the previous connection lasted at least `HEALTHY_MS`.

**Failing to open is a drop.** The promise rejection path calls the same `drop`. A stream that cannot open (no transport yet, no binding) must degrade to polling, not throw into a render path.

Sharing is a reference-counted registry. The last release stops the stream:

```ts
const feeds = new Map<string, Feed<any>>();

/** Share one stream per key; the last release stops it. */
export function acquire<T extends Item>(
  key: string,
  open: Open<T>,
  listener: (s: FeedState<T>) => void,
): () => void {
  let feed = feeds.get(key) as Feed<T> | undefined;
  if (!feed) {
    feed = new Feed(open);
    feeds.set(key, feed);
  }
  feed.refs += 1;
  feed.listeners.add(listener);
  listener(feed.state);
  const held = feed;
  return () => {
    held.listeners.delete(listener);
    if (--held.refs > 0) return;
    held.dispose();
    feeds.delete(key);
  };
}
```

The client also pauses every subscription while the app is in the background, following [React Native's `AppState`](https://reactnative.dev/docs/appstate). iOS suspends a backgrounded app, so it cannot be relied on to hold the socket, and a clean reconnect on return is better than a half-dead connection.

## The fallback poll is a function of the stream

The poll has exactly one reason to run: the stream is not delivering. Everything else is off.

```ts
const STEPS_MS = [5_000, 10_000, 20_000, 30_000];

/** Fallback poll cadence: widen while nothing changes, snap back on change. */
export class FallbackSchedule {
  private step = 0;
  next(changed: boolean): number {
    this.step = changed ? 0 : Math.min(this.step + 1, STEPS_MS.length - 1);
    return STEPS_MS[this.step]!;
  }
  reset() {
    this.step = 0;
  }
}

/** false = do not poll at all. */
export function pollInterval(o: {
  live: boolean;
  foreground: boolean;
  schedule: FallbackSchedule;
}): number | false {
  if (!o.foreground) return false; // nothing is on screen
  if (o.live) return false; // the stream is the source of truth
  return STEPS_MS[0]!; // caller widens it with schedule.next(changed)
}
```

There are three rules in that file. Hidden means no polling. Live means no polling. Not live means poll, and when nothing keeps changing, widen the interval. The widening schedule matters in environments where subscriptions are unavailable altogether (an old host, a restricted network): without it, a client that cannot subscribe polls at the fastest cadence forever. The cost is detection lag that is bounded by the largest step.

I tested these with fake timers (Node's `node:test` with `mock.timers`, which also mocks `Date`). The cases that earned their place: an open without a snapshot is not live; a drop keeps the list, flips `live`, and retries after 1 s then 2 s; a connection that stays healthy resets the delay; two consumers share one stream and the last release stops it.

## When a stream can stand in for a second signal

The client also polled the control plane every so often to learn whether the machine was online and still bound to the current user. The stream looks like a replacement: it only flows if the machine is online and the grant is valid. But a stream cannot *announce* going offline in this system, because online-ness is computed from a "last seen" timestamp. Nothing is written when a machine disappears, so there is no event to push.

So the rule became: while the stream flows, presence is proven by the stream itself and the control-plane poll stops. When the stream drops, `live` flips, the poll resumes, and the offline state appears within one poll interval as before. I considered making the database emit a notification when presence changes and rejected it because the migration and trigger risk was not proportionate to the saving.

## A bug that only existed because of the poll

Removing the poll exposed a hidden dependency on its side effect. The transport remembered the conversations it had seen and used that to start per-conversation subscriptions. Conversations delivered through the list stream were not remembered. That went unnoticed while the poll was running, and with the poll off a newly started conversation arrived on the stream but could not be subscribed to. The fix was to record stream-delivered items in the transport, and the regression test hands the transport an item that only ever arrived via the stream.

This is the general hazard: a redundant poll is also an unreviewed second implementation of your state machine. When you delete it, grep for what it was incidentally populating.

## Using notifications to decide staleness

The same idea applies to cached reads. A working-copy diff screen used to refetch whenever it was shown after a staleness window. Now it subscribes to the host's file-change notifications while it is visible. While that notification stream is alive, the cached diff is never considered stale; when it is not, the ordinary time-based staleness applies again.

In TanStack Query terms: `staleTime: live ? Infinity : undefined`, plus an invalidation when a notification arrives. Switching between screens stops refetching, and edits made while the user is looking at the screen now show up, which the polling version never did.

One more detail from that change: if the subscription is rejected, retry after a delay even when something asks for an immediate retry (app foregrounded, network back). Those "retry now" signals are designed for transient failures. A rejection is not transient, and honoring "retry now" turns it into a tight loop.

## When not to use this

- **You cannot distinguish "stream down" from "nothing is happening".** Without a snapshot-first protocol or heartbeats, a silent stream looks identical to a quiet one, and the poll must stay.
- **The event source does not cover what you display.** Presence worked here only because of an argument about what the stream implies. If no such argument exists, keep polling that signal.
- **Events can be lost without a resume cursor.** A subscription is an optimization over a source of truth. If you cannot re-read the truth on reconnect, you have replaced a poll with a bug. The companion article *Coalescing Realtime Invalidations* covers that side.
- **The poll is already cheap.** On a transport that does not meter messages, a five-line interval is better than a shared refcounted registry.

## What I did and did not verify

The unit tests above pass, including the failure case where a stream opens but never delivers. I did not measure message counts or battery on devices, and the savings stated here are derived from the number of scheduled requests removed.

## Summary

- A subscription replaces a poll only if `live` means "data arrived", not "socket opened".
- Share one stream per key by reference count; keep the last list across drops; reset backoff only after a connection proved healthy.
- Make the fallback a pure function of `live` and visibility, and widen it while nothing changes.
- A stream may stand in for another signal only if you can state why; accept and write down the weaker detection latency.
- Deleting a poll can remove side effects the rest of the system relied on. Look for them before shipping.
