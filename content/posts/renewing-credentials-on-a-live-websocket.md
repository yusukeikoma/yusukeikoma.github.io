---
title: "Renewing Credentials on a Live WebSocket"
date: 2026-10-02T16:40:00+09:00
draft: true
tags: ["websocket", "authentication", "go", "javascript"]
summary: "A long-lived socket outlives the short-lived credential that admitted it. Renewing in place avoids a reconnect and a resubscribe, but only if the renewal is bound to the connection it renews, can only extend, wins at most once, and degrades to a plain reconnect on every failure."
math: false
---

# Renewing Credentials on a Live WebSocket

A WebSocket is authenticated once, at the HTTP upgrade. Credentials worth issuing are short-lived. The socket is neither. Sooner or later the credential that admitted the connection expires while the connection is healthy and busy, and you must choose between ending it and extending it.

This article is about the patterns that make extending it safe. It deliberately says nothing about any particular token format, claim set or lifetime; those are specific to a deployment, and the structure below does not depend on them.

## Reconnect at expiry, and why people want to avoid it

The baseline is simple and correct: before the credential expires, close the socket, fetch a fresh credential, and connect again. It needs no server support, so it should remain the fallback no matter what you build.

It has costs that grow with the system:

- Every in-flight stream is cut. The client has to notice, resubscribe, and tolerate a gap in events.
- On a relay that persists subscriptions, resubscribing is a burst of messages, and on a metered one a burst you pay for.
- Reconnect logic is a state machine. Every extra pass through it is another chance to hit a race. (One such race is the subject of *When the Close Event Never Comes*.)

In-place renewal removes the gap: the connection and its subscriptions stay as they are, and only the authorization window moves.

## Where the new credential travels

After the upgrade you cannot attach new headers to the socket. You have two options.

**A message on the socket.** The client sends a "here is my new credential" frame. It is simple, but it puts credential handling on the data path, in the same parser that handles everything else. The frame also races with whatever else the socket is carrying.

**A separate authenticated request that names the live connection.** The client makes an ordinary HTTP call to the same service. The server's normal request authentication runs, and the handler then looks up the live socket and updates the state it holds. The data path never parses a credential.

Both can be made correct. The rest of this article assumes the second shape because it reuses the code path that is already hardened, but the properties below apply to either.

## Properties a renewal must have

Treat the renewal endpoint as an attack surface that can extend a lifetime, because that is what it does.

**Same identity.** The new credential must belong to the same subject the socket was admitted for. A valid credential for somebody else is still not a valid renewal of this socket.

**Strictly extends.** The new expiry must be later than the current one. If renewal can shorten or merely repeat, an old credential that leaks from a log can be replayed to roll state backwards.

**Bound to the current state.** Require the *previous* credential as well and check that it is still unexpired and still the one the socket was admitted with. This makes renewal a proof of possession of the current session, not just of some valid credential.

**Wins at most once.** Two renewals racing, or the same renewal delivered twice, must not both succeed. Give the socket state a generation and do a compare-and-swap on it: the request carries the generation it expects to replace, and only one request wins. On Durable Objects the state lives next to the socket, so as long as the state is read and written without yielding in between, the swap is a plain read-modify-write with no distributed coordination ([WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) covers where per-socket state can be kept across hibernation).

Here is the server decision as a pure function. The token format (a signed JSON blob with `sub`, `gen`, `exp`) is invented for the example.

```js
/**
 * In-band renewal for a socket the server already holds.
 * `live` is the state stored on the live socket (survives hibernation).
 * Returns the HTTP status and the state to store.
 */
export function renew({ live, previousToken, newToken, key, now }) {
  let prev, next;
  try {
    prev = verify(previousToken, key); // both must be validly signed, and the old
    next = verify(newToken, key); //     one must not be expired
  } catch {
    return { status: 401, live };
  }
  if (prev.exp <= now) return { status: 401, live };
  if (prev.sub !== next.sub || prev.sub !== live.sub) return { status: 403, live };
  if (next.exp <= prev.exp) return { status: 409, live }; // must extend, never shorten
  // Compare-and-swap on the generation: the old token must be the one the live
  // socket was admitted with. A replayed or obsolete renewal loses here.
  if (live.generation !== prev.gen) return { status: 409, live };
  return { status: 204, live: { ...live, generation: next.gen, exp: next.exp } };
}
```

The status codes distinguish "not authenticated" (401), "authenticated but not for this socket" (403), and "valid but not applicable now" (409, which covers a replay, a stale generation, and a non-extending expiry). A client that sees 409 is not wrong to have tried; it just lost, and the fallback is the same as for every other failure.

The tests pin each property separately, including the one that is easy to forget, replay:

```js
test('the same renewal cannot be replayed', () => {
  const first = go();
  const again = go({ live: first.live });
  assert.equal(again.status, 409);
});
```

Note that the server also has to keep enforcing the stored expiry: a socket whose renewal never arrives must be closed when its window ends. Renewal extends a deadline; it must not remove the deadline.

## The client: send nothing unless it is safe

The caller holds a credential and obtains the next one from a source (a token endpoint). Before it sends anything, it checks the properties it can check locally: same identity, same endpoint, same key, strictly later expiry.

The endpoint and key checks are about where the credential goes, not just what it is. If the issuer rotated its key or moved the endpoint, the old socket should not be given anything new. It is better to fall back to the reconnect path, which resolves the new endpoint from scratch, than to push a credential to wherever the socket happens to point.

```go
// ErrReconnect means: do not keep this socket; fall back to an ordinary reconnect.
var ErrReconnect = errors.New("in-band renewal unavailable")

// Renew refuses to send anything unless the new credential is the same
// identity and strictly extends the old one. Every failure collapses into
// ErrReconnect, so an older server (404), a rotated key, or a denial all take
// the path that already worked before renewal existed.
func Renew(ctx context.Context, src Source, prev Credential, post Post) (Credential, error) {
	next, err := src.Fetch(ctx)
	if err != nil {
		return Credential{}, fmt.Errorf("%w: %v", ErrReconnect, err)
	}
	if next.Subject != prev.Subject || next.Endpoint != prev.Endpoint ||
		next.KeyID != prev.KeyID || !next.ExpiresAt.After(prev.ExpiresAt) {
		return Credential{}, fmt.Errorf("%w: identity or expiry changed", ErrReconnect)
	}
	status, err := post(ctx, prev, next)
	if err != nil || status != 204 {
		return Credential{}, fmt.Errorf("%w: status %d", ErrReconnect, status)
	}
	return next, nil
}
```

All failures collapse into one error, `ErrReconnect`, whose meaning is "take the path that worked before renewal existed". Denials, an older server answering 404, a lost race, a network error and a rotated key all mean exactly that. This is the property that makes renewal safe to roll out: it is an optimization layered on a mechanism that already works, so its failure modes are not new failure modes.

```go
// Renew refuses to send anything unless the new credential is the same
// identity and strictly extends the old one. Every failure collapses into
// ErrReconnect, so an older server (404), a rotated key, or a denial all take
// the path that already worked before renewal existed.
func Renew(ctx context.Context, src Source, prev Credential, post Post) (Credential, error) {
	next, err := src.Fetch(ctx)
	if err != nil {
		return Credential{}, fmt.Errorf("%w: %v", ErrReconnect, err)
	}
	if next.Subject != prev.Subject || next.Endpoint != prev.Endpoint ||
		next.KeyID != prev.KeyID || !next.ExpiresAt.After(prev.ExpiresAt) {
		return Credential{}, fmt.Errorf("%w: identity or expiry changed", ErrReconnect)
	}
	status, err := post(ctx, prev, next)
	if err != nil || status != 204 {
		return Credential{}, fmt.Errorf("%w: status %d", ErrReconnect, status)
	}
	return next, nil
}
```

### Timing

Renewal must start early enough to retry before expiry, and each attempt needs a deadline so a hung request cannot eat the remaining window. `Maintain` waits until `lead` before expiry, gives the attempt until `deadline` before expiry, and on any failure returns so the caller can reconnect while the old credential is still valid. A reconnect that starts with a still-valid credential has no gap.

```go
// Maintain renews `lead` before expiry, giving each attempt until `deadline`
// before expiry. It returns when the socket must be replaced or ctx ends.
// supported comes from the connect handshake; without it, nothing is sent and
// the caller reconnects at expiry exactly as before.
func Maintain(ctx context.Context, supported bool, cur *Credential, lead, deadline time.Duration, src Source, post Post, onRenewed func(Credential)) error {
	if !supported {
		if err := waitUntil(ctx, cur.ExpiresAt.Add(-deadline)); err != nil {
			return err
		}
		return ErrReconnect // reconnect just before expiry, as before renewal existed
	}
	for {
		if err := waitUntil(ctx, cur.ExpiresAt.Add(-lead)); err != nil {
			return err
		}
		attempt, cancel := context.WithDeadline(ctx, cur.ExpiresAt.Add(-deadline))
		next, err := Renew(attempt, src, *cur, post)
		cancel()
		if err != nil {
			return err // caller reconnects
		}
		*cur = next
		onRenewed(next)
	}
}
```

### Capability, not assumption

The `supported` flag comes from the connection handshake: the server says in the upgrade response that it understands in-place renewal. A client that does not see it sends nothing and reconnects before expiry, exactly as it did before the feature existed. The test asserts the strong form of that: zero renewal requests, not "requests that are ignored".

```go
func TestOlderServerSendsNoRequestsAndReconnectsAtExpiry(t *testing.T) {
	cur := base(100 * time.Millisecond)
	var posts, fetches atomic.Int32
	src := countingSource{&fetches}
	err := Maintain(context.Background(), false, &cur, 50*time.Millisecond, 10*time.Millisecond, src,
		func(context.Context, Credential, Credential) (int, error) { posts.Add(1); return 204, nil },
		func(Credential) {})
	if !errors.Is(err, ErrReconnect) || posts.Load() != 0 || fetches.Load() != 0 {
		t.Fatalf("err=%v posts=%d fetches=%d", err, posts.Load(), fetches.Load())
	}
}
```

This is what lets client and server ship in either order. Never infer capability from the absence of an error.

### Handlers that are mid-call

Renewal changes the credential while other goroutines are using it. If a handler reads the credential field by field, it can combine the old token with the new expiry. Hand out copies:

```go
// Holder gives in-flight handlers a consistent snapshot while renewal swaps
// the credential. Handlers copy the value once and use the copy for the whole
// call; they never read fields of a shared struct that may change underneath.
type Holder struct {
	mu  sync.RWMutex
	cur Credential
}
```

A handler calls `Snapshot()` once and uses that value for the whole operation. The test hammers the holder with readers while it flips between two values that must always match, and runs under the race detector.

```go
func TestSnapshotsAreNeverTorn(t *testing.T) {
	// Token and Subject always change together; a torn read would mix them.
	h := NewHolder(Credential{Subject: "a", Token: "a"})
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					if c := h.Snapshot(); c.Subject != c.Token {
						t.Errorf("torn snapshot: %+v", c)
						return
					}
				}
			}
		}()
	}
	for i := 0; i < 2000; i++ {
		v := "a"
		if i%2 == 1 {
			v = "b"
		}
		h.Replace(Credential{Subject: v, Token: v, ExpiresAt: time.Unix(int64(i), 0)})
	}
	close(stop)
	wg.Wait()
}
```

## When not to use this

- **Lifetimes are long relative to connection lifetimes.** If connections rarely outlive their credential, reconnect-at-expiry has no cost worth optimizing.
- **Reconnecting is cheap and invisible.** Stateless streams that resume from a cursor lose nothing by reconnecting.
- **You cannot make failure fall back.** If a failed renewal would leave a half-extended session instead of a clean reconnect, in-place renewal is more dangerous than it is worth.
- **Revocation has to be immediate.** Renewal is a point at which revocation is checked, not a substitute for a revocation channel. If revocation must take effect faster than the credential lifetime, close the socket from the server on revocation.

## What I did and did not verify

The samples are tested as shown: the server decision under `node:test`, the client under `go test -race`. The production change was also exercised locally on the Workers runtime with SQLite-backed Durable Objects. I did not run a long soak against the real platform, so I make no claim about behavior over many renewal cycles in production.

## Summary

- Renewing in place keeps the connection and its subscriptions; reconnecting at expiry stays as the fallback.
- A renewal must keep the identity, strictly extend the expiry, present the previous credential, and win a compare-and-swap at most once.
- The client refuses to send unless identity, endpoint, key and expiry all check out locally.
- Every failure collapses to one error that means "reconnect"; support is learned from the handshake, never assumed.
- Share credentials with in-flight work as immutable snapshots.
- The server keeps enforcing the stored expiry.
