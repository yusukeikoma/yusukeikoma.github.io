---
title: "golangci-lint の段階導入から PostgreSQL の行ロックまで：Go バックエンド開発で役立った 5 つのテクニック"
date: 2026-09-26T20:00:00+09:00
draft: true
tags: ["go", "golangci-lint", "concurrency", "postgresql", "macos"]
summary: "既存の Go コードベースに lint を段階的に入れる方法、go test -race の仕組みと CI 導入、外部コマンド（git / rg）を context 付きで安全に呼ぶ方法、launchctl bootout/bootstrap の競合、PostgreSQL の FOR UPDATE と FOR NO KEY UPDATE の違いをまとめました。"
math: false
isCJKLanguage: true
---

普段は AI プロダクト（Cogno）の開発をしています。この記事では、最近の開発で扱った技術のうち、ほかのプロジェクトでも役立ちそうなものを 5 つ選び、それぞれの仕組み・使いどころ・ハマりどころをまとめます。コード例はすべて説明用に書き下ろしたものです。

1. 既存の Go コードベースに、コード規約と golangci-lint を段階的に導入する
2. `go test -race` でデータ競合を見つけ、CI で常に回す
3. `git` や `rg` などの外部コマンドを `context.Context` 付きで呼ぶ（検索のフォールバックも含む）
4. launchd の `bootout` → `bootstrap` で起きる競合（EIO）への対処
5. PostgreSQL の `FOR UPDATE` と `FOR NO KEY UPDATE` の使い分け

## 1. Go のコード規約を「文書」と「機械チェック」に分ける

### 規約は公開された出典に寄せる

チームの慣習がレビューコメントの積み重ねでしかないと、同じ指摘を何度も繰り返すことになり、新しく入った人も何に従えばよいのか分かりません。そこで規約を文書にします。ただ、ゼロから書くと「好みの押し付け」になりやすいので、各項目に公開された出典を付けるのがおすすめです。

- [Effective Go](https://go.dev/doc/effective_go)
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)
- [Google Go Style Guide](https://google.github.io/styleguide/go/)
- [Uber Go Style Guide](https://github.com/uber-go/guide)
- [Go Proverbs](https://go-proverbs.github.io/)

たとえば「interface は小さく保つ」という項目なら、Go Proverbs の *"The bigger the interface, the weaker the abstraction."* を根拠にできます。また Code Review Comments には、interface は実装する側ではなく**使う側のパッケージ**に置くのが一般的だと書かれています。出典があれば、議論は「誰の好みか」ではなく「このプロジェクトに当てはまるか」に集中できます。

さらに、各ルールが次のどちらなのかを文書の中で区別しておくと、運用が楽になります。

- **機械で検出できるルール**（関数の複雑度、interface のメソッド数、`context` の受け渡しなど）→ linter で強制する
- **判断が必要なルール**（命名、パッケージの切り方など）→ レビューで見る

### golangci-lint v2 の設定例

機械で検出できるルールは golangci-lint にまとめます。v2 系では設定ファイルの先頭に `version: "2"` を書き、linter ごとの設定を `linters.settings` の下に置きます。

```yaml
# .golangci.yml
version: "2"

linters:
  default: standard        # errcheck, govet, staticcheck, unused など
  enable:
    - gocyclo              # 循環的複雑度
    - gocognit             # 認知的複雑度（ネストの深さを重く見る）
    - interfacebloat       # interface のメソッド数
    - contextcheck         # 受け取った context を引き継いでいるか
    - noctx                # context なしの HTTP リクエストなどを検出
    - nolintlint           # //nolint の書き方を検査
  settings:
    gocyclo:
      min-complexity: 15   # デフォルトは 30（リファレンスでは 10〜20 を推奨）
    interfacebloat:
      max: 5
    nolintlint:
      require-explanation: true   # //nolint には理由を必須にする
      require-specific: true      # どの linter を無視するかを必須にする
```

`nolintlint` を入れておくと、`//nolint` が無秩序に増えるのを防げます。例外を認める場合も、次のように linter 名と理由を書かせます。

```go
//nolint:gocyclo // プロトコルの状態遷移表をそのまま写しているため、分割すると逆に読みにくくなる
func (p *parser) step(b byte) error {
```

### 既存コードへの段階的な導入

既存のコードベースに lint を入れると、最初は大量の違反が出ます。全部直すまで CI に入れない、というやり方では永遠に入りません。そこで次の 2 段階に分けます。

**ステップ 1：新しいコードだけを検査する。** `issues.new-from-merge-base` を使うと、指定したブランチとの merge-base より後に入った違反だけが報告されます。

```yaml
issues:
  new-from-merge-base: main
```

これで「今日から書くコードは規約に従う」状態をすぐに作れます。注意点として、この機能は git の差分を使うので、CI で checkout するときに履歴が必要です（GitHub Actions なら `fetch-depth: 0` など）。

**ステップ 2：パッケージ単位で既存の違反を解消する。** まだ直していないパッケージを `exclusions.rules` で一時的に除外し、直したパッケージから除外を外していきます。

```yaml
linters:
  exclusions:
    warn-unused: true          # 使われなくなった除外ルールを警告する
    rules:
      - path: internal/legacy/   # TODO: 解消したらこの行を消す
        linters: [gocyclo, gocognit]
```

`warn-unused: true` にしておくと、違反を直し終えたのに除外ルールだけが残っている状態に気づけます。すべての除外を外せたら、`new-from-merge-base` も外してリポジトリ全体を検査します。

### 複雑度の高い関数を分解するときの考え方

gocyclo が数える循環的複雑度は、おおまかには「1 + 分岐の数」です（`if`、`for`、`case`、`&&`、`||` などが 1 つずつ加算されます）。数百行の関数で値が大きくなるのは、たいてい次のどれかが原因です。

- 1 つの `switch` に、各ケースの処理がそのまま書かれている
- エラー処理とメインの処理がネストの中で入り組んでいる
- 「準備 → 実行 → 後始末」のような複数のフェーズが 1 関数に同居している

たとえば、イベントの種類ごとに処理を振り分ける関数を考えます。

```go
// Before: 分岐がすべて 1 関数に集まっている
func (w *Worker) Handle(ev Event) error {
	switch ev.Kind {
	case KindStart:
		if w.running {
			return errAlreadyRunning
		}
		if ev.Config == nil {
			return errMissingConfig
		}
		// ...数十行...
	case KindStop:
		// ...数十行...
	case KindReload:
		// ...数十行...
	}
	return nil
}
```

各ケースをメソッドに切り出して、振り分けはテーブルにします。

```go
// After: 振り分けと処理を分ける
func (w *Worker) Handle(ev Event) error {
	h, ok := w.handlers()[ev.Kind]
	if !ok {
		return fmt.Errorf("unknown event kind: %v", ev.Kind)
	}
	return h(ev)
}

func (w *Worker) handlers() map[Kind]func(Event) error {
	return map[Kind]func(Event) error{
		KindStart:  w.start,
		KindStop:   w.stop,
		KindReload: w.reload,
	}
}

func (w *Worker) start(ev Event) error {
	if w.running {
		return errAlreadyRunning
	}
	if ev.Config == nil {
		return errMissingConfig
	}
	// ...
	return nil
}
```

分岐の総数が減るわけではありません。関数ごとに分散させるだけです。それでも、各関数を単独でテストでき、読むときに頭に置いておく状態も少なくなります。

分解するときの注意点もあります。

- **機械的に `helper1`、`helper2` と切らない。** 引数が 6 個も 7 個もある関数ができたら、分け方が間違っているサインです。関数の間で受け渡している状態を小さな struct にまとめるか、フェーズの境界を見直します。
- **先にガード節（早期 return）を使う。** `if err == nil { ... }` の中に本体を書くのをやめるだけで、ネストがかなり浅くなります。
- **挙動を変えるリファクタリングと混ぜない。** 分解だけのコミットを分けておくと、レビューもしやすく、問題が起きたときの切り戻しも簡単です。

## 2. `go test -race` でデータ競合を見つける

### 仕組みと制約

データ競合とは、2 つの goroutine が同じ変数に同時にアクセスし、少なくとも一方が書き込みである状態のことです。Go には競合検出器が組み込まれていて、`-race` を付けてビルドまたはテストすると、実行時にメモリアクセスを記録して競合を報告してくれます。

```sh
go test -race ./...
```

知っておくべき制約が 3 つあります（いずれも[公式ドキュメント](https://go.dev/doc/articles/race_detector)に書かれています）。

- **実際に実行されたコードパスしか検出できません。** テストで通らない経路の競合は見つかりません。
- **オーバーヘッドが大きいです。** 一般的なプログラムで、メモリ使用量は 5〜10 倍、実行時間は 2〜20 倍になります。本番バイナリを常に `-race` で動かすのは現実的ではありません。
- **cgo が必要です。** Darwin 以外では C コンパイラも必要なので、`CGO_ENABLED=0` を指定している環境ではビルドできません。

### よくある競合パターン

公式ドキュメントにも典型例が並んでいます。実際のコードで特に多いと感じたのは次の 2 つです。

**(a) ロックを型の外で扱っている**

```go
// 競合しやすい: ロックの取り方を利用側に任せている
type Registry struct {
	Mu    sync.Mutex
	Items map[string]Item
}

// 呼び出し側の 1 か所でも Mu を取り忘れると、それだけで競合になる
r.Items[id] = item
```

ロックを取るかどうかが利用側の規律に任されていると、呼び出し箇所が増えるほど取り忘れが出てきます。ロックは状態を持つ型の中に閉じ込めて、外からはメソッドでしか触れないようにします。

```go
type Registry struct {
	mu    sync.RWMutex
	items map[string]Item
}

func (r *Registry) Put(id string, it Item) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[id] = it
}

func (r *Registry) Get(id string) (Item, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	it, ok := r.items[id]
	return it, ok
}

// 内部の map をそのまま返すと、ロックの外で読まれてしまう。コピーを返す。
func (r *Registry) Snapshot() map[string]Item {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return maps.Clone(r.items)
}
```

見落としやすいのが最後の `Snapshot` です。内部の map や slice の参照をそのまま返すと、せっかく閉じ込めたロックの外で読み書きされてしまいます。

**(b) テスト用の fake が goroutine から呼ばれる**

本体のコードは正しくても、テストで使う fake やモックが競合していることがよくあります。

```go
type fakeNotifier struct {
	mu   sync.Mutex
	sent []string
}

func (f *fakeNotifier) Notify(msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, msg) // ロックがないと、並行に呼ばれたとき競合する
}
```

単純なカウンタやフラグなら、`sync/atomic` の `atomic.Int64` や `atomic.Bool` を使うのも手です。

### CI で常に回す

`-race` は「たまに手元で回す」だけだと効果が薄く、CI で毎回回してはじめて意味があります。GitHub Actions なら、たとえば次のように書けます。

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: go test -race -count=1 ./...
```

`-count=1` を付けると、テスト結果のキャッシュを使わずに毎回実行されます。競合はタイミングによって出たり出なかったりするので、キャッシュされた「成功」を信じないほうが安全です。

導入したばかりのときは、既存の競合で CI が赤くなります。本当に競合している箇所は直しますが、タイムアウトの設定がきついテストが `-race` の遅さで落ちているだけ、というケースも混ざっています。報告の中身（競合したアクセスのスタックトレース）を読んで、どちらなのかを切り分けてください。

## 3. 外部コマンドを `context.Context` 付きで呼ぶ

### `exec.CommandContext` と `WaitDelay`

Go から `git` などの外部コマンドを呼ぶとき、`exec.Command` を使うと呼び出し元がキャンセルされてもコマンドは動き続けます。HTTP リクエストのハンドラから呼んでいる場合、クライアントが切断したあとも重い `git log` が走り続けることになります。

`exec.CommandContext` を使えば、context が終了したときにプロセスを止められます。デフォルトの動作は `Process.Kill` です。Go 1.20 以降は `Cancel`（終了時に何をするか）と `WaitDelay`（その後どれだけ待つか）も設定できます。

```go
func runGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", // 認証プロンプトで固まらないようにする
		"GIT_OPTIONAL_LOCKS=0",  // 読み取り系で index.lock を取りにいかないようにする
	)
	// Kill した後も、子プロセスがパイプを握っていると Wait が返らないことがある。
	// WaitDelay を過ぎたらパイプを閉じて戻る。
	cmd.WaitDelay = 2 * time.Second

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	out, err := cmd.Output()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("git %s: %w", args[0], ctxErr)
		}
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, bytes.TrimSpace(stderr.Bytes()))
	}
	return out, nil
}
```

ポイントは 3 つです。

- **`WaitDelay` を設定する。** `Kill` で止まるのは直接起動した `git` だけです。`git` が起動した子プロセス（ssh や pager など）が標準出力のパイプを開いたままだと、`Wait` が返ってこないことがあります。
- **キャンセルによる失敗と、コマンド自体の失敗を分ける。** キャンセルされた場合、`err` は `signal: killed` のような分かりにくいものになりがちです。先に `ctx.Err()` を確認すると、ログを見る人に原因が伝わります。
- **非対話にする。** `GIT_TERMINAL_PROMPT=0` がないと、認証が必要なリモート操作で入力待ちのまま止まることがあります。`GIT_OPTIONAL_LOCKS=0` は、`git status` のような読み取り系コマンドがインデックスを更新するためにロックを取るのを抑止します。並行して書き込み系の操作が走る環境では、ロックの取り合いを減らせます。

関数の奥で `context.Background()` を作り直してしまう書き方は、前述の `contextcheck` などの linter で検出できます。

### 検索コマンドのフォールバック：`rg` → `git grep` → `grep`

作業ディレクトリ内の全文検索を実装するとき、環境によって使えるツールが違うことがあります。そこで、速いものから順に試すフォールバックを組みます。

- **`rg`（ripgrep）**：速い。デフォルトで `.gitignore` を尊重し、隠しファイルとバイナリを飛ばす
- **`git grep`**：git リポジトリ内なら、ほぼ必ず使える。追跡対象のファイルを検索する（未追跡のファイルも含めるなら `--untracked`）
- **`grep -r`**：最後の手段。どこにでもあるが、無視設定を理解しないので `node_modules` なども検索してしまう

```go
type searcher struct {
	bin  string
	args func(pattern string) []string
}

var searchers = []searcher{
	{"rg", func(p string) []string {
		return []string{"--line-number", "--no-heading", "--with-filename",
			"--color=never", "--fixed-strings", "-e", p, "."}
	}},
	{"git", func(p string) []string {
		return []string{"grep", "--line-number", "--fixed-strings", "-I", "-e", p}
	}},
	{"grep", func(p string) []string {
		return []string{"-r", "-n", "-I", "-F", "-e", p, "."}
	}},
}

func Search(ctx context.Context, dir, pattern string) ([]byte, error) {
	for _, s := range searchers {
		path, err := exec.LookPath(s.bin)
		if err != nil {
			continue // インストールされていない
		}
		cmd := exec.CommandContext(ctx, path, s.args(pattern)...)
		cmd.Dir = dir
		out, err := cmd.Output()
		if err == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return nil, nil // 「マッチなし」は正常な結果
		}
		// それ以外（リポジトリ外での git grep など）は次の手段へ
	}
	return nil, errors.New("no search tool available")
}
```

ハマりどころは次のとおりです。

- **終了コード 1 は「失敗」ではありません。** `rg`、`git grep`、`grep` はいずれも、マッチがないと 1 で終了します。これをエラーとして扱って次のツールに進むと、見つからないたびに 3 つのツールすべてで検索することになります。
- **終了コード 2 でも結果が出ていることがあります。** `rg` や `grep` は、一部のファイルを読めなかった（権限がないなど）場合、マッチを出力したうえで 2 で終了します。部分的な結果でも返すかどうかは、用途に応じて決めてください。
- **パターンは `-e` で渡します。** ユーザーが入力した文字列が `-` で始まっていると、オプションとして解釈されてしまいます。`-e` で渡せば、3 つのツールすべてで安全です。
- **出力形式をそろえます。** 上の引数なら、どのツールも `path:line:text` の形で出力します（違いはパスの先頭に `./` が付くかどうかだけ）。これならパーサーを 1 つにできます。
- **検索対象のパスは明示します。** `rg` はパスを省略すると、条件によっては標準入力を検索しようとします。サブプロセスとして呼ぶときは `.` を明示しておくと確実です。

## 4. launchd の `bootout` → `bootstrap` で起きる競合（EIO）

macOS で常駐プロセスを LaunchAgent として管理していると、更新のときに plist を差し替えて再読み込みしたくなります。今のやり方は `launchctl bootout` でいったん外し、`launchctl bootstrap` で読み込み直す流れです。

```sh
launchctl bootout   "gui/$(id -u)/com.example.agent"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.example.agent.plist
```

これを続けて実行すると、ときどき次のエラーで失敗します。

```text
Bootstrap failed: 5: Input/output error
```

原因は、`bootout` が launchd 側でのアンロード完了を待たずに戻ることです。古いジョブがまだ登録されているところに同じラベルで `bootstrap` すると、EIO になります。しかも `bootout` 自体は成功しているので、`KeepAlive` を設定していても自動では復帰しません。更新しただけでサービスが止まったまま、ということが起こります。

対策は「待つ」と「限定的にリトライする」の組み合わせです。

```sh
label=com.example.agent
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"

# 未ロードのときの bootout はエラーになるが、ここでは無視してよい
launchctl bootout "$domain/$label" 2>/dev/null || true

# 1) ラベルが消えるまで待つ（launchctl print は未登録なら非 0 で終了する）
for _ in $(seq 1 50); do
  launchctl print "$domain/$label" >/dev/null 2>&1 || break
  sleep 0.2
done

# 2) それでも EIO が出たときだけ、回数を決めてリトライする
ok=0
for attempt in 1 2 3 4 5; do
  if out=$(launchctl bootstrap "$domain" "$plist" 2>&1); then
    ok=1
    break
  fi
  case "$out" in
    *"Input/output error"*) sleep "$attempt" ;;
    *) break ;;  # それ以外のエラーは待っても直らない
  esac
done

if [ "$ok" -ne 1 ]; then
  echo "bootstrap failed: $out" >&2
  exit 1
fi
```

注意点です。

- **EIO は競合以外でも出ます。** plist の中身やパスが間違っていても同じエラーになることがあるので、無限にリトライしてはいけません。事前に `plutil -lint "$plist"` で構文を確認しておくと、原因を切り分けやすくなります。
- **リトライは EIO に限定します。** 権限エラーなど、待っても直らない失敗はすぐに表に出したほうが調査が早く済みます。
- **最後に動作を確認します。** `bootstrap` が成功したあと、`launchctl print` で状態を確認しておくと安心です。

Linux の systemd では、`systemctl stop` や `restart` はデフォルトでジョブの完了を待ってから戻ります（`--no-block` を付けない限り）。そのため同じ形の競合は起きにくいです。代わりに、ユニットファイルを書き換えたあとの `systemctl --user daemon-reload` を忘れやすいので注意してください。ユニット名を変えるときは、古いユニットを `disable --now` してファイルを消し、`daemon-reload` してから新しいユニットを `enable --now` する、という順番にすると、古いユニットが残りません。

## 5. PostgreSQL：`FOR UPDATE` と `FOR NO KEY UPDATE`

### 外部キーの INSERT が待たされる理由

「親の行を `SELECT ... FOR UPDATE` でロックして更新している間、子テーブルへの INSERT がなぜか待たされる」という現象があります。例として、次のテーブルを考えます。

```sql
CREATE TABLE orders (
  id     bigint PRIMARY KEY,
  status text NOT NULL
);

CREATE TABLE order_items (
  id       bigint PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  sku      text NOT NULL
);
```

```sql
-- セッション A
BEGIN;
SELECT * FROM orders WHERE id = 1 FOR UPDATE;
UPDATE orders SET status = 'closed' WHERE id = 1;
-- ...しばらく別の処理...

-- セッション B（A がコミットするまで待たされる）
INSERT INTO order_items (id, order_id, sku) VALUES (100, 1, 'X');
```

子テーブルに INSERT すると、PostgreSQL は外部キー制約を保証するために、参照先の親の行（`orders.id = 1`）を `FOR KEY SHARE` でロックします。親の行を消されたり、キーを書き換えられたりしないようにするためです。そして[行ロックの競合表](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)を見ると、`FOR KEY SHARE` と競合するのは `FOR UPDATE` だけです。

| 要求 \ 保持中 | FOR KEY SHARE | FOR SHARE | FOR NO KEY UPDATE | FOR UPDATE |
|---|---|---|---|---|
| FOR KEY SHARE | | | | ✕ |
| FOR SHARE | | | ✕ | ✕ |
| FOR NO KEY UPDATE | | ✕ | ✕ | ✕ |
| FOR UPDATE | ✕ | ✕ | ✕ | ✕ |

つまり、親を `FOR UPDATE` でロックしている間は、その親を参照する子の INSERT がすべて待たされます。

### キーを変えないなら `FOR NO KEY UPDATE`

`FOR NO KEY UPDATE` は「この行を更新するが、キー（外部キーから参照されうる一意なカラム）は変えないし、行も削除しない」という意味のロックです。他の更新やロックからは `FOR UPDATE` と同じように守られますが、`FOR KEY SHARE` はブロックしません。

```sql
-- セッション A
BEGIN;
SELECT * FROM orders WHERE id = 1 FOR NO KEY UPDATE;
UPDATE orders SET status = 'closed' WHERE id = 1;

-- セッション B（待たされずに進む）
INSERT INTO order_items (id, order_id, sku) VALUES (100, 1, 'X');
```

実は、キーを変えない普通の `UPDATE` は、もともと内部で `FOR NO KEY UPDATE` 相当のロックしか取りません。問題になるのは、アプリケーション側で明示的に `SELECT ... FOR UPDATE` している場合です。ORM の「悲観ロック」機能はデフォルトで `FOR UPDATE` を発行することが多いので、一度確認してみる価値があります。たとえば Django なら `select_for_update(no_key=True)`、SQLAlchemy なら `with_for_update(key_share=True)` で `FOR NO KEY UPDATE` を指定できます。

### 使ってはいけない場面

- **その行を `DELETE` する場合や、主キー・一意キーを書き換える場合**は `FOR UPDATE` が必要です（実際、これらの操作は内部で `FOR UPDATE` 相当のロックを取ります）。
- **子の INSERT をあえて止めたい場合**（「注文の確定処理中は明細を追加させない」など）は、弱いロックにすると意図が崩れます。その場合は、ロックの強さではなく、アプリケーション側のチェックや制約で表現するほうが明確です。

ロック待ちを調べるときは、`pg_locks` ビューと `pg_blocking_pids(pid)` 関数を使うと、どのセッションがどのセッションを止めているのかを追えます。

## まとめ

- **lint** は「新しいコードだけを検査」→「パッケージ単位で既存の違反を解消」の 2 段階で入れると、既存のコードベースでも止まらずに進められます。
- **`-race`** は実行されたコードパスしか見ないので、CI で毎回回してはじめて効果が出ます。ロックは型の中に閉じ込めて、内部の状態の参照を外に漏らさないことが大切です。
- **外部コマンド** は `CommandContext` と `WaitDelay` で止められるようにしておき、終了コードの意味（1 は「マッチなし」）をツールごとに確認します。
- **launchd** の `bootout` は非同期です。待ってから、EIO に限定して回数を決めてリトライします。
- **PostgreSQL** では、キーを変えない更新なら `FOR NO KEY UPDATE` にすることで、外部キー経由の INSERT を止めずに済みます。

どれも地味な話ですが、知っているかどうかで障害の起きやすさがかなり変わるものばかりでした。同じところでハマっている人の参考になればうれしいです。
