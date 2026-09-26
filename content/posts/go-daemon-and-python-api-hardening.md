---
title: "Hardening a Go Daemon and a Python API"
date: 2026-09-26T19:00:00+09:00
draft: false
tags: ["go", "python", "postgresql", "concurrency", "macos"]
summary: "Five techniques from a polyglot codebase: rolling out golangci-lint on existing Go code, running the race detector in CI, bounding subprocess lifetimes, re-registering launchd services without the bootout race, and choosing PostgreSQL row-lock strength around foreign keys."
math: false
---

# Hardening a Go Daemon and a Python API: Lint, Races, Subprocesses, launchd, and Row Locks

The codebase I work on is a polyglot monorepo. A long-running Go daemon and its CLI sit next to a Python API backed by PostgreSQL.

This post collects five techniques from recent work on it. They are not related to each other, but they share one idea: most production problems come from something that is stronger, longer-lived, or less deterministic than it needs to be. That can be a lock, a process, a retry, or a rule that only exists in review comments.

All code in this post is written for illustration. The Go examples come from the daemon and CLI side; the Python example comes from the API side.

## 1. Enforcing a Go style guide on an existing codebase

### The problem

Conventions that live only in review comments do not scale. Reviewers repeat themselves, the rules drift, and new contributors cannot find out what the rules are. The usual fix, turning on a linter, fails on an existing codebase for a different reason: the first run produces a wall of findings, and a wall of findings gets the linter disabled.

### Rollout: gate new code first, then burn down by package

`issues.new-from-merge-base` reports only findings introduced after the merge base with the target branch. From the first day, new code has to comply, while old code is left alone. Prefer it over `new-from-rev`. A revision like `origin/main` is a moving tip: once the base branch advances past your branch point, the diff against it contains other people's changes, and you get their findings. The merge base does not move. The CI checkout needs full history for this (`fetch-depth: 0` in `actions/checkout`), because a shallow clone has no merge base to compute.

The existing violations are then removed one package at a time. Where a function cannot be fixed yet, give it a specific suppression, for example `//nolint:gocyclo // pre-existing; tracked for refactor`. With `nolintlint`, every exception is greppable and carries a reason, and the burn-down is a matter of deleting those lines. When no legacy suppressions remain, drop `new-from-merge-base` and lint the whole tree.

On the refactoring itself: high cyclomatic complexity in a long function almost always comes from a handful of shapes. A `switch` inlines every case body. Error handling is interleaved with the happy path inside nested blocks. Several phases (prepare, execute, finalize) share one body. Extracting phases into methods and inlined cases into a dispatch table resolves most of it. The trap is extracting helpers that take seven parameters. That means the state they share should become a small struct, or the phase boundaries are wrong. Keep behavior-preserving extractions in separate commits from behavior changes.

Do not force every function under the threshold. A parser or protocol state machine whose single `switch` mirrors a specification is easier to check against that specification as one function. That is exactly what an explained `//nolint` is for.

### architecture tests with `go/parser`

Some rules are structural and no linter covers them. For example, every internal package must document its boundary, or a given service type may cross package boundaries only behind an interface. These are cheap to enforce as ordinary tests that parse the source tree:

```go
package boundaries

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every package under internal/ states what it is in a package comment.
func TestInternalPackagesAreDocumented(t *testing.T) {
	root := filepath.Join("..", "..", "internal")
	err := filepath.WalkDir(root, func(dir string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return err
		}
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		documented, hasSource := false, false
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			hasSource = true
			f, err := parser.ParseFile(token.NewFileSet(), file, nil,
				parser.PackageClauseOnly|parser.ParseComments)
			if err != nil {
				return err
			}
			documented = documented || f.Doc != nil
		}
		if hasSource && !documented {
			t.Errorf("%s has no package comment", dir)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
```

The same approach, walking `ast.StructType` and `ast.FuncType` nodes and resolving selector expressions through the file's imports, enforces "hold an interface, not the concrete type" across packages. Keep an explicit allowlist of known exceptions, and make the test fail when an allowlist entry becomes stale. That way the list only shrinks.

## 2. Running the race detector on every CI run

### The decision

The [race detector](https://go.dev/doc/articles/race_detector) only reports races that actually happen during an execution. A race on a path that does not run under the right interleaving goes unnoticed. That makes an occasional local `-race` run close to worthless. The detector pays off only when the full suite runs under it on every change.

The documented cost, 2–20x in execution time and 5–10x in memory, is what usually stops teams. That overhead comes from instrumenting memory accesses and synchronization, though. A suite dominated by waiting on subprocesses, sockets, and timers pays much less than a CPU-bound one. Measure your heaviest package before deciding. The other hard requirement is cgo, plus a C toolchain on non-Darwin platforms, so `CGO_ENABLED=0` builds cannot use it.

```yaml
- run: go test -race -parallel 4 ./...
```

`-parallel` defaults to `GOMAXPROCS`. When every parallel test spawns real processes and file watchers, that default can exhaust per-process file descriptor limits on macOS runners. Set an explicit bound.

### What it found

The races that turned up were not in production logic. They lived in the scaffolding around it, which is typical of a codebase that has never run under the detector:

**A `bytes.Buffer` used as a log sink.** A test hands a buffer to the logger and then reads it while the server goroutine is still writing. `bytes.Buffer` is not safe for concurrent use. Wrap it:

```go
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
```

**An exported field on a test fake, flipped mid-test.** A fake with `Hold bool` is configured at construction, then the test sets `fake.Hold = false` while the goroutine running the fake reads it. Move the field behind the fake's own mutex and expose a method, so the lock cannot be bypassed:

```go
type fakeRunner struct {
	mu   sync.Mutex
	hold bool
}

// SetHold toggles whether Run waits for release; chaining keeps setup terse.
func (f *fakeRunner) SetHold(v bool) *fakeRunner {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hold = v
	return f
}

func (f *fakeRunner) holding() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hold
}
```

**A package-level variable assigned at startup.** A `SetLogger` that assigns a global is fine in a process that boots once. A test binary that starts the daemon many times assigns it while background goroutines from the previous instance still read it. `atomic.Pointer` makes the swap safe without a mutex on the hot path:

```go
var pkgLogger atomic.Pointer[slog.Logger]

func SetLogger(l *slog.Logger) {
	if l != nil {
		pkgLogger.Store(l)
	}
}

func logger() *slog.Logger {
	if l := pkgLogger.Load(); l != nil {
		return l
	}
	return slog.Default()
}
```

All three share one root cause: the synchronization contract was left to the caller. The durable fix is to put the lock inside the type that owns the state. Never return references to internal maps or slices from behind that lock; return copies, for example with `maps.Clone`.

Excluding a test from race builds with `//go:build !race` is legitimate only when the failure is a timing assertion that the detector's slowdown breaks. It should never hide an actual report.

## 3. Bounding subprocess lifetimes

### The decision: reads follow the caller, writes finish

A daemon that shells out to `git` needs a policy for what happens to the child when the caller goes away. The policy I settled on depends on what the command does.

- **Read-only commands** (`status`, `log`, `diff`, `rev-parse`, `grep`) are bound to the caller's `context.Context`. If the HTTP client disconnects or the daemon shuts down, the child is killed. Nobody wants the answer anymore.
- **Mutating commands** (`commit`, `checkout`, `worktree add`, `config` writes) run to completion under their own timeout. A caller leaving is not a reason to abandon a half-created worktree or a stale `index.lock`.
- **Every command** has a ceiling timeout regardless. A git process that hangs on a credential helper, a network filesystem, or a stale lock should become a reportable error rather than a stuck goroutine.

### The mechanism, and where it falls short

`exec.CommandContext` calls `cmd.Cancel` when the context is done. By default that is `Process.Kill`, which is `SIGKILL` on Unix. It reaches the **direct child only**. `git fetch` spawns `ssh` and credential helpers, and those grandchildren survive. If they inherited the child's stdout, `Wait` blocks: the goroutine copying the pipe waits for EOF, and EOF only comes when every process holding the write end has exited.

Two mechanisms address this, and they compose (`Cancel` and `WaitDelay` require Go 1.20+):

- `cmd.WaitDelay` bounds how long `Wait` waits after cancellation (or after the child exits) before it force-closes the pipes and returns. It guarantees that `Wait` returns, not that the processes are gone.
- A process group plus a custom `Cancel` delivers the signal to the whole tree:

```go
//go:build unix

func commandInGroup(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// A negative pid signals the whole process group.
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
```

This comes with trade-offs. `Setpgid` takes the child out of the terminal's foreground process group, so an interactive `Ctrl-C` no longer reaches it. For a daemon that is correct; for a CLI that forwards a TTY it is not. If `Cancel` sends `SIGTERM` instead, to allow a graceful exit, keep in mind that the escalation after `WaitDelay` is `Process.Kill` on the group leader only. Windows needs Job Objects for the same guarantee. For read-only commands, `SIGKILL` to the group is the right default, because there is nothing to clean up.

### Making git non-interactive and parseable

```go
cmd.Env = append(cmd.Environ(),
	"GIT_TERMINAL_PROMPT=0", // fail instead of prompting for credentials
	"GIT_OPTIONAL_LOCKS=0",  // reads must not take index.lock
)
// -c core.quotepath=off prints non-ASCII paths verbatim instead of quoted octal.
```

`GIT_OPTIONAL_LOCKS=0` is the subtle one. By default `git status` opportunistically refreshes the index and takes `index.lock` to do it. If another process is committing in the same working tree, one of the two fails with "index.lock exists". Read paths should never contend with write paths for that lock.

Keep stdout as the return value and stderr in the error. A warning git prints on the way to success must never end up in a parsed SHA. Check `ctx.Err()` before interpreting the exit status, so that a cancellation is reported as a cancellation and not as `signal: killed`. Map known stderr shapes, such as "not a git repository" or an unborn `HEAD`, to sentinel errors in one place, so that callers use `errors.Is` instead of string matching.

### Case study: full-text search with a tool fallback

Content search over a working copy should be delegated to tools that already do it well, not reimplemented. The fallback order is `rg`, then `git grep`, then `grep`. Each tool behaves differently in ways that matter:

- **`rg`** respects `.gitignore` and skips hidden and binary files. Add `--hidden` so dotfiles such as `.github/` are searched, then exclude `.git/` explicitly with a glob. `--json` gives unambiguous structured output.
- **`git grep`** only works inside a work tree. Probe with `git rev-parse --is-inside-work-tree` and fall through if the answer is not `true`. Add `--untracked` to include untracked, non-ignored files. Use `-z` so a path containing a colon stays unambiguous.
- **`grep -r`** knows nothing about ignore files. Pass `--exclude-dir` for `.git`, `node_modules`, and the like. `--null` works in both GNU and BSD grep.

Use literal matching (`-F` / `--fixed-strings`) everywhere, and pass the pattern with `-e` after the options, followed by `--` before the path. A user query that starts with `-` is otherwise parsed as a flag. Resolve each binary once with `sync.OnceValue(func() string { p, _ := exec.LookPath("rg"); return p })`.

The runner needs to handle three things correctly: bounded concurrency, a result cap, and the difference between stopping on purpose and being cancelled.

```go
var searchSlots = make(chan struct{}, 3) // rg already fans out across cores

func runSearch(ctx context.Context, dir, bin string, args []string, limit int,
	parse func([]byte) (Match, bool)) ([]Match, bool, error) {
	select { // wait for a slot, but give up if the caller does
	case searchSlots <- struct{}{}:
		defer func() { <-searchSlots }()
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}

	caller := ctx
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}

	var matches []Match
	partial := false
	sc := bufio.NewScanner(stdout)
	sc.Buffer(nil, 1<<20) // allow long lines, e.g. bundled JavaScript
	for sc.Scan() {
		if len(matches) == limit {
			partial = true
			break
		}
		if m, ok := parse(sc.Bytes()); ok {
			matches = append(matches, m)
		}
	}
	cancel()                           // stop the tool where it stands
	_, _ = io.Copy(io.Discard, stdout) // finish reading before Wait
	waitErr := cmd.Wait()

	if err := caller.Err(); err != nil {
		return nil, false, err // caller cancellation must not look like zero matches
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !partial && !(errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1) {
		return nil, false, waitErr // exit 1 means "no matches" for all three tools
	}
	return matches, partial, nil
}
```

The ordering at the end matters. `os/exec` documents that calling `Wait` before all reads from `StdoutPipe` have completed is incorrect, hence the drain. Reaching the cap cancels the context on purpose, so the resulting kill is not a failure. It is a partial result, and the response should say so. A cancellation that originates with the caller has to return the context error. Returning an empty slice would read as "nothing matched."

`rg` and `grep` exit with status 2 when some files could not be read, even if they printed matches. Decide whether a partial result on a permission error is acceptable for your use case. The runner above treats it as a failure unless the cap was reached.

## 4. Re-registering launchd services without the bootout race

### The failure mode

Upgrading a macOS LaunchAgent in place means rewriting the plist and reloading the service:

```text
launchctl bootout   gui/501/com.example.agent
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.example.agent.plist
```

Run back to back, the second command intermittently fails:

```text
Bootstrap failed: 5: Input/output error
```

`bootout` is acknowledged before teardown completes. launchd sends `SIGTERM`, waits up to the job's `ExitTimeOut` before escalating to `SIGKILL`, and removes the service from the domain asynchronously. A `bootstrap` of the same label during that window gets `EIO`. The damaging part is what comes next. `bootout` succeeded, so launchd considers the job cleanly unloaded, and `KeepAlive` will not bring it back. An upgrade that should cost a restart leaves the service down.

### Wait for absence, then retry with a bound

```go
func bootout(target string) {
	_ = exec.Command("launchctl", "bootout", target).Run() // not loaded is fine
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		// print exits non-zero once the label is gone from the domain.
		if exec.Command("launchctl", "print", target).Run() != nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func bootstrap(domain, plist string) error {
	var out []byte
	var err error
	for attempt := 1; attempt <= 6; attempt++ {
		if out, err = exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt) * 300 * time.Millisecond) // linear backoff
	}
	return fmt.Errorf("launchctl bootstrap %s: %w: %s", plist, err, bytes.TrimSpace(out))
}
```

The polling handles the common case. The retry covers the residual window between the label disappearing from `print` and launchd being ready to accept it again. The retry has to be bounded, because `EIO` is not specific to the race: a malformed plist or a bad path can produce the same error. Filtering retries to the `Input/output error` string makes other failures surface faster. Either way, validate the plist first (`plutil -lint`) and include the last output in the error.

### Restart semantics are part of the definition

`KeepAlive` with `Crashed = true` restarts the job only when it dies from a crash signal such as `SIGSEGV`. A process that exits with a non-zero status on purpose, for example to have its supervisor restart it, is not restarted. For that, use `SuccessfulExit = false`, which restarts on any non-zero exit. launchd also throttles respawns (`ThrottleInterval`, 10 seconds by default), so a crash loop slows down rather than spinning. The systemd equivalent is `Restart=on-failure`.

This matters during upgrades. An old installation may carry a definition with the wrong restart policy or a stale binary path. On every upgrade, render the definition the current version would write, compare it to what is installed, and re-register when they differ. The operation is idempotent and fixes old installs without a separate migration step.

systemd does not have the same race. `systemctl stop` and `restart` wait for the job to complete unless `--no-block` is given. Its common failures are forgetting `systemctl --user daemon-reload` after changing a unit, and expecting a user unit to run without a login session, which requires `loginctl enable-linger`.

## 5. PostgreSQL: `FOR UPDATE` versus `FOR NO KEY UPDATE`

### The problem

A common way to serialize a state transition on a parent row is to read it with `SELECT ... FOR UPDATE`, decide, and write. That makes the transition wait for **every in-flight transaction that inserted or updated a row referencing the parent through a foreign key**. The reverse also holds: while the parent is locked, those child writes wait. On a busy parent row the result is a lock convoy, even though none of these operations modify the parent's key.

### The mechanism

A foreign-key check on the child side is implemented as a system trigger that effectively runs `SELECT 1 FROM ONLY parent WHERE pk = $1 FOR KEY SHARE`. It runs at the end of the inserting statement, or at commit for a deferred constraint, and the lock is held until the child's transaction ends. `FOR KEY SHARE` guarantees that the referenced key will not be deleted or changed underneath the child. According to the [row-level lock conflict table](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS), the only mode it conflicts with is `FOR UPDATE`:

| Requested \ Held  | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|-------------------|-----------|-------|---------------|--------|
| FOR KEY SHARE     |           |       |               | X      |
| FOR SHARE         |           |       | X             | X      |
| FOR NO KEY UPDATE |           | X     | X             | X      |
| FOR UPDATE        | X         | X     | X             | X      |

Row locks are recorded in the tuple header (`xmax`) rather than in the shared lock table. When several transactions hold a shared lock on one row, as concurrent FK checks do, PostgreSQL records them as a MultiXact. Plain `SELECT`s never wait on any of this, because MVCC readers do not take row locks.

The detail that makes the fix safe is this. An `UPDATE` that does not modify a key column already takes `FOR NO KEY UPDATE` on its own. PostgreSQL defines "key column" here as a column covered by a unique index that a foreign key can reference, which excludes partial and expression indexes. An explicit `FOR UPDATE` before such an update is therefore **stronger than the write that follows**, and the extra strength buys nothing except conflicts with FK checks.

### The fix

The examples use this schema:

```sql
CREATE TABLE orders (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status    text NOT NULL DEFAULT 'open',
  closed_at timestamptz
);

CREATE TABLE order_items (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id),
  sku      text NOT NULL
);
```

`FOR NO KEY UPDATE` still conflicts with itself, so two transitions on the same row remain serialized. It does not conflict with `FOR KEY SHARE`, so child inserts proceed. With psycopg 3:

```python
from psycopg import AsyncConnection


async def close_order(conn: AsyncConnection, order_id: int) -> str:
    async with conn.transaction():
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT status FROM orders WHERE id = %s FOR NO KEY UPDATE",
                (order_id,),
            )
            row = await cur.fetchone()
            if row is None:
                return "missing"
            if row[0] == "closed":
                return "already_closed"  # idempotent replay
            await cur.execute(
                "UPDATE orders SET status = 'closed', closed_at = now() WHERE id = %s",
                (order_id,),
            )
            return "closed"
```

### Testing the lock, not the timing

A timing-based test for lock behavior is flaky in both directions. `lock_timeout` turns "would have waited" into a deterministic `LockNotAvailable` error (SQLSTATE `55P03`). Hold a `FOR KEY SHARE` from an open transaction that inserted a child row, then run the operation under a short `lock_timeout`:

```python
import asyncio

import pytest
from psycopg import AsyncConnection
from psycopg.errors import LockNotAvailable

DSN = "postgresql://localhost/test"
# `order_id` is a pytest fixture that inserts an open order and yields its id.


async def hold_fk_share(order_id: int, release: asyncio.Event) -> None:
    async with await AsyncConnection.connect(DSN) as conn:
        await conn.execute(
            "INSERT INTO order_items (order_id, sku) VALUES (%s, 'X')", (order_id,)
        )
        await release.wait()  # keep the transaction, and its KEY SHARE, open
        await conn.rollback()


async def with_writer_in_flight(order_id: int, sql: str) -> None:
    release = asyncio.Event()
    holder = asyncio.create_task(hold_fk_share(order_id, release))
    try:
        await asyncio.sleep(0.2)
        async with await AsyncConnection.connect(DSN) as conn:
            await conn.execute("SET lock_timeout = '2s'")
            await conn.execute(sql, (order_id,))
            await conn.rollback()
    finally:
        release.set()
        await holder


@pytest.mark.asyncio
async def test_no_key_update_does_not_wait_for_fk_writers(order_id: int) -> None:
    await with_writer_in_flight(
        order_id, "SELECT 1 FROM orders WHERE id = %s FOR NO KEY UPDATE"
    )


@pytest.mark.asyncio
async def test_for_update_would_have_waited(order_id: int) -> None:
    with pytest.raises(LockNotAvailable):
        await with_writer_in_flight(order_id, "SELECT 1 FROM orders WHERE id = %s FOR UPDATE")
```

The negative control is not optional. Without it, the positive test passes no matter which lock mode the code uses, because a free lock never hits the timeout. A third test should assert that two concurrent transitions still serialize, which is the property the lock was there for in the first place.

### When not to weaken it

- **When the transaction will delete the row or change its key.** Those statements take `FOR UPDATE` anyway. Locking weaker first means an upgrade later, and lock upgrades are a classic source of deadlocks. The PostgreSQL docs advise acquiring the most restrictive mode you will need first.
- **When blocking child inserts is the intent**, for example "no new line items while an order is being finalized." A weaker lock silently removes that guarantee. Encode the intent explicitly, with a status check in the child's write path or a constraint, instead of relying on a side effect of the lock mode.
- **When there is no read-decide-write logic at all.** A single conditional `UPDATE orders SET status = 'closed' WHERE id = %s AND status <> 'closed' RETURNING id` needs no explicit lock. It takes `FOR NO KEY UPDATE` implicitly, and there is no separate read step to hold that lock across.

## Conclusion

Each of these five issues is the same mistake in a different layer:

* a lint rule that only exists in review comments
* a synchronization contract left to the caller
* a subprocess that outlives the request that started it
* a retry assumed to be unnecessary because the previous command returned
* a row lock stronger than the write it protects

The fixes share a principle: **match strength and lifetime to the operation, and make the correct behavior deterministic and machine-checked.** Gate only new code, then burn down the rest. Run the race detector on every change. Kill the whole process tree on cancellation, and let writes finish. Wait until the teardown can actually be observed before bootstrapping. Take the weakest row lock that still serializes what needs serializing, and prove it with a test that would fail under the stronger one.
