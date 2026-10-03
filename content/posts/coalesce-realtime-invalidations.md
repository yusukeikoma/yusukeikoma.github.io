---
title: "Coalescing Realtime Invalidations: Key Scoping and a Leading/Trailing Window"
date: 2026-10-03T13:30:00+09:00
draft: false
tags: ["typescript", "react-native", "react-query", "realtime"]
summary: "Realtime events that invalidate a client cache can multiply into far more refetches than the data changed. Two small fixes, a predicate that only matches list keys and a per-key leading/trailing window, and the rules around them that keep the result correct."
math: false
---

# Coalescing Realtime Invalidations: Key Scoping and a Leading/Trailing Window

A WebSocket tells a mobile client "a task changed". The client's reaction is one line: invalidate the cache for that workspace and let the data layer refetch whatever is on screen. It is correct, it is two lines of code, and it can quietly turn one change into dozens of requests.

This article is about the two multipliers in that line and the smallest fixes for each. The code uses TanStack Query's [`invalidateQueries`](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation) vocabulary, but nothing here depends on it.

## Two multipliers

**Key fan-out.** Query keys are hierarchical. A list is `['tasks', ws, filter]`. A task's detail is `['tasks', ws, 'detail', id]`. Its actions, its linked pull requests and so on live under the same `['tasks', ws]` prefix. Invalidating the prefix refetches every one of those that is currently mounted. A change to task 7 therefore refetches the detail screen for task 12 that happens to be open in another tab.

**Event bursts.** An agent run or a bulk edit does not produce one event. It produces a burst, and each event used to refetch a full page of the list.

The trade-off is between freshness and request volume, with a correctness constraint on top: whatever you do to reduce requests must never leave the screen showing a state older than the last event.

## Fix 1: invalidate lists with a predicate, items by exact key

The keys of a list and the keys of an item differ in their third segment. A list has no third segment, or an object (the filter). Everything else is item-level. That is enough to write a predicate:

```ts
type Key = readonly unknown[];

/** Minimal slice of a query client (TanStack Query shaped). */
export interface Cache {
  invalidate(opts: { key: Key; predicate?: (key: Key) => boolean }): void;
}

/**
 * Keys share a prefix: ['tasks', ws] is a list; ['tasks', ws, 'detail', id]
 * is one item. A prefix invalidation hits both. A list key has either no third
 * segment or an object (the filter); everything else is item-level.
 */
export function isList(key: Key): boolean {
  const third = key[2];
  return third === undefined || (typeof third === 'object' && third !== null);
}

export const WINDOW_MS = 2_000;
```

Two choices follow from that. A `task.changed` event that carries an id invalidates the lists through the predicate, and invalidates that one task's detail by its exact key. A bulk reorder event carries no id at all, because many items moved in one operation, so it refreshes only the lists. Events name the narrowest keys that changed, and the handler never reaches for a bigger one.

The predicate depends on the shape of your keys. Pin the shape with a test that feeds both kinds of key into the predicate. The test is cheap and it fails when someone adds a key family with an unexpected third segment.

## Fix 2: a leading and trailing window per key

Scoping reduces what each refetch touches. It does not reduce how many refetches a burst causes. For that I used a window that fires on the leading edge, then at most once per window while events continue:

```ts
const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; again: boolean }>();

/** Leading edge now; at most one trailing refetch per window while events keep coming. */
export function refreshLists(cache: Cache, prefix: Key): void {
  const id = JSON.stringify(prefix);
  const open = windows.get(id);
  if (open) {
    open.again = true; // remember that something arrived inside the window
    return;
  }
  const run = () => cache.invalidate({ key: prefix, predicate: isList });
  run(); // leading: a lone event is reflected immediately
  const close = () => {
    const w = windows.get(id);
    if (!w?.again) {
      windows.delete(id); // quiet window: next event is a leading edge again
      return;
    }
    w.again = false;
    run(); // trailing
    w.timer = setTimeout(close, WINDOW_MS); // keep the window open while events continue
  };
  windows.set(id, { timer: setTimeout(close, WINDOW_MS), again: false });
}
```

The behavior, event by event:

1. The first event refreshes immediately and opens a window.
2. Events that arrive inside the window set a flag and nothing else.
3. When the window ends with the flag set, one refetch runs and the window re-arms. When it ends without the flag, the state is deleted.
4. The next event after a quiet window is a leading edge again.

So a lone change is reflected immediately, a burst costs one leading and one trailing refetch, and a long burst costs one refetch per window, not per event. The leading edge is why this is not a plain debounce: a debounce makes a single change wait for the quiet period. The trailing edge is why this is not a plain throttle: a throttle that only fires on the leading edge drops the last event of a burst and leaves the screen stale. The re-arm in step 3 is the easy thing to forget. Without it, the second trailing refetch of a long burst never runs.

State is per key (`JSON.stringify(prefix)`), so two workspaces do not share a window.

```ts
export function onTaskChanged(cache: Cache, workspace: number, taskId: number | null): void {
  refreshLists(cache, ['tasks', workspace]);
  if (taskId != null) cache.invalidate({ key: ['tasks', workspace, 'detail', taskId] });
}
```

The per-item invalidation stays outside the window, because it is one request for the one item that changed.

I verified this with fake timers: twenty events in a row give one leading refetch and one trailing refetch, a further window with no events gives none, and an event after the window closes is a leading edge again. A lone event leaves no trailing refetch behind.

Two testing notes from doing this. Module-level window state needs an exported reset, or one test's open window leaks into the next. And with fake timers, clear that state while the fake clock that created the timers is still installed, then restore real timers. I got the order wrong first and the leaked timer made the following test fail in a way that looked like a logic bug.

## Reconnecting is not being in sync

A burst of events is the easy case. The hard one is the events you did not receive. This event stream has no sequence numbers and no resume cursor, so after a disconnect the client cannot know what it missed. On a phone that happens constantly, because iOS suspends a backgrounded app and the socket goes with it. The client therefore follows app state (disconnect in the background, connect in the foreground), and every successful connect triggers a re-read of the lists:

```ts
// No sequence numbers or resume cursor in the event stream: after any
// (re)connect the client cannot know what it missed, so it re-reads.
export function onConnected(cache: Cache, workspace: number): void {
  cache.invalidate({ key: ['tasks', workspace] });
}
```

The rule I use: if the event stream cannot tell you what you missed, then the API is the record of truth, and a (re)connect is the moment to consult it again. Events are a hint to refetch sooner. They are not the data.

## Verify that your invalidation has a subscriber

While doing the above I found something less interesting and more instructive. The realtime wiring was already in place: it held a socket open in the foreground, fetched tokens, reconnected on app-state changes, and invalidated cache keys on every event. No query in the app used those keys yet. Every invalidation was a no-op against a cache entry that did not exist.

A unit test of the handler would not have caught this, because it asserts that `invalidateQueries` is called with the right keys, which it was. It cannot assert that someone is listening. When you add realtime to a client, add one assertion that connects the two ends: a query that uses the key is registered, or the key is produced by the same factory the query uses. Otherwise the feature can run, cost battery and traffic, and update nothing.

## When not to use this

- **You need every intermediate state.** An audit view or a live cursor must see each event. Coalescing is a lossy compression of a stream of hints.
- **Events carry the data.** If an event contains the full new value, patch it into the cache (`setQueryData`) and skip the refetch. Windowing a refetch only makes sense when the event is a pointer.
- **The refetch is trivial.** A tiny list that comes from a local cache does not need a window. Add the window when a profile shows the burst, not before.
- **Strict ordering across keys matters.** The window delays the list relative to item-level refreshes. If a screen shows both and must agree, refresh them together or accept a short mismatch.

## What I did and did not verify

The unit tests with fake timers pass, as above. I did not count events or refetches on a device, so I make no claim about how many requests this saves in practice. The claim is structural: the number of list refetches in a burst is bounded by the number of windows, not events.

## Summary

- Key prefixes that cover both lists and items turn one change into many refetches. Invalidate lists with a predicate and items by exact key.
- A leading and trailing window per key keeps single changes instant, bounds bursts, and never drops the last event, provided the trailing timer re-arms.
- Without sequence numbers, a reconnect means re-reading. Treat events as hints.
- Add a check that your invalidation has a subscriber. Handlers that call the right function can still be wired to nothing.
