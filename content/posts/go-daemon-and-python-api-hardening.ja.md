---
title: "Go デーモンと Python API の堅牢化"
date: 2026-09-26T19:00:00+09:00
draft: false
tags: ["go", "python", "postgresql", "concurrency", "macos"]
summary: "複数言語が同居するコードベースで得た 5 つの手法。既存の Go コードへの golangci-lint の段階導入、CI でのレースディテクタの常時実行、サブプロセスの寿命の制御、bootout の競合を避けた launchd サービスの再登録、そして外部キーを踏まえた PostgreSQL の行ロック強度の選び方。"
math: false
isCJKLanguage: true
---

# Go デーモンと Python API の堅牢化：Lint、データ競合、サブプロセス、launchd、行ロック

私が携わっているコードベースは、複数の言語が同居するモノレポだ。常駐する Go のデーモンとその CLI が、PostgreSQL をバックエンドとする Python の API と並んでいる。

本稿では、このコードベースでの最近の作業から得た 5 つの手法をまとめる。互いに直接の関係はないが、根底にある考え方は共通している。本番で起きる問題の多くは、必要以上に強い、長命な、あるいは非決定的な何かに起因する、ということだ。それはロックであることもあれば、プロセスやリトライ、あるいはレビューコメントの中にしか存在しないルールであることもある。

本稿のコードはすべて説明のために書き起こしたものだ。Go の例はデーモンと CLI 側、Python の例は API 側を題材にしている。

## 1. 既存のコードベースに Go のスタイルガイドを適用する

### 課題

レビューコメントの中にしか存在しない規約はスケールしない。レビュアーは同じ指摘を繰り返し、ルールは少しずつぶれていき、新しく加わったメンバーはそもそもルールが何なのかを知る手段がない。定番の解決策は linter を有効にすることだが、既存のコードベースでは別の理由でうまくいかない。初回の実行で大量の指摘が一度に出て、その指摘の山を前に結局 linter が無効化されてしまうのだ。

### 設計：すべてのルールに出典を示し、機械的に検査できるかどうかで分ける

ガイドは、すべてのルールが公開された出典を参照するように書いた。[Effective Go](https://go.dev/doc/effective_go)、[Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)、[Google](https://google.github.io/styleguide/go/) と [Uber](https://github.com/uber-go/guide) のスタイルガイド、そして [Go Proverbs](https://go-proverbs.github.io/) だ。出典のあるルールなら、議論は「これは誰の好みか」から「これはこのケースに当てはまるか」に移る。

そのうえで、各ルールを機械的に検査できるものと、判断を要するものに分類する。linter の設定に入れるのは前者だけで、linter の各エントリには、それが担保するルールを明記する。命名やパッケージ境界のような判断を要するルールはレビューに残す。これを linter に載せても、ノイズが増えて `//nolint` が散乱するだけだ。

```yaml
# .golangci.yml (golangci-lint v2)
version: "2"

linters:
  enable:
    - containedctx    # struct のフィールドに context.Context を持たせない
    - contextcheck    # 呼び出し元の context を伝播し、新たに作らない
    - errorlint       # %w でラップし、== や型 switch ではなく errors.Is/As を使う
    - gocyclo
    - gocognit        # gocyclo が考慮しないネストの深さを重み付けする
    - interfacebloat
    - nestif
    - nolintlint      # すべての抑制に linter 名と理由を明記させる
    - staticcheck
  settings:
    gocyclo:
      min-complexity: 15
    nolintlint:
      require-explanation: true
      require-specific: true
    staticcheck:
      checks: ["all", "-ST1005"]

issues:
  new-from-merge-base: origin/main
  max-issues-per-linter: 0
  max-same-issues: 0
```

1 つだけ説明が必要なエントリがある。`ST1005` は、エラー文字列を小文字で始めることを求めるチェックだ。これは固有名詞やエクスポートされた識別子と、普通の単語とを区別できない。エラーメッセージがプロダクト名やツール名で始まるコードベースでは、抑制コメントをばらまくか、メッセージの質を落とすかの二択を迫られる。そこでこのチェックは無効にし、ルール自体はレビュー項目として残した。あるチェックを全面的に有効にする前に、それが実際に何を報告するのかを確認しておくべきだ。

### 導入：まず新しいコードをゲートし、既存の違反はパッケージ単位で解消する

`issues.new-from-merge-base` は、ターゲットブランチとのマージベース以降に持ち込まれた指摘だけを報告する。これにより、初日から新しいコードには準拠を求めつつ、既存のコードには手を付けずに済む。`new-from-rev` ではなくこちらを選ぶべきだ。`origin/main` のようなリビジョンは動き続ける先端であり、ベースブランチが自分の分岐点より先に進むと、それとの差分には他人の変更が含まれ、他人の指摘まで報告されてしまう。マージベースは動かない。ただし、CI のチェックアウトには全履歴が必要になる（`actions/checkout` の `fetch-depth: 0`）。shallow clone ではマージベースを計算できないからだ。

既存の違反は、その後パッケージ単位で 1 つずつ取り除いていく。まだ直せない関数には、`//nolint:gocyclo // pre-existing; tracked for refactor` のように個別の抑制を付ける。`nolintlint` があれば、すべての例外が grep で見つかり、理由も付いている。解消作業は、それらの行を消していくだけの話になる。レガシーの抑制が 1 つも残らなくなったら、`new-from-merge-base` を外してツリー全体を lint する。

リファクタリングそのものについても触れておく。長い関数の循環的複雑度が高くなる原因は、ほぼ決まった数パターンに収まる。`switch` がすべての case の本体をインラインで抱えている。エラー処理が、ネストしたブロックの中で正常系と交互に現れる。複数のフェーズ（準備、実行、後処理）が 1 つの関数本体を共有している。フェーズをメソッドに、インライン化された case をディスパッチテーブルに切り出せば、ほとんどは解消する。落とし穴は、引数が 7 つもあるヘルパーを切り出してしまうことだ。それは、ヘルパー間で共有している状態を小さな struct にまとめるべきか、フェーズの切り方が間違っているかのどちらかを意味する。振る舞いを変えない切り出しは、振る舞いを変えるコミットとは別のコミットにしておく。

すべての関数を無理に閾値以下に収める必要はない。単一の `switch` が仕様をそのまま写しているパーサやプロトコルのステートマシンは、1 つの関数のままのほうが仕様と照らし合わせやすい。理由付きの `//nolint` は、まさにこういうときのためにある。

### lint の先へ：`go/parser` によるアーキテクチャテスト

構造に関するルールの中には、どの linter もカバーしていないものがある。たとえば、internal 配下のすべてのパッケージは自身の境界をドキュメント化しなければならない、あるいは特定のサービス型はインターフェース越しにしかパッケージ境界をまたいではならない、といったルールだ。こうしたルールは、ソースツリーをパースする普通のテストとして安価に強制できる。

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

// internal/ 配下のすべてのパッケージは、パッケージコメントで自身の役割を説明する。
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

同じ手法で、`ast.StructType` と `ast.FuncType` のノードを走査し、セレクタ式をファイルの import を通じて解決すれば、パッケージをまたいで「具象型ではなくインターフェースを保持する」ことを強制できる。既知の例外は明示的な許可リストで管理し、許可リストのエントリが不要になったらテストが失敗するようにしておく。そうすれば、リストは縮む一方になる。

## 2. すべての CI 実行でレースディテクタを走らせる

### 判断

[レースディテクタ](https://go.dev/doc/articles/race_detector)は、実行中に実際に発生したデータ競合しか報告しない。適切なインターリーブで実行されなかった経路上の競合は見逃される。そのため、ローカルでたまに `-race` を付けて実行する程度では、ほとんど意味がない。レースディテクタが元を取れるのは、変更のたびにテストスイート全体をその下で実行した場合だけだ。

多くのチームを思いとどまらせるのは、ドキュメントに記載されたコスト、つまり実行時間で 2〜20 倍、メモリで 5〜10 倍というオーバーヘッドだ。ただし、このオーバーヘッドはメモリアクセスと同期処理の計装から生じる。サブプロセス、ソケット、タイマーの待ち時間が大半を占めるテストスイートなら、CPU バウンドなものよりはるかに負担は小さい。判断する前に、最も重いパッケージで計測してみるとよい。もう 1 つの必須要件は cgo で、Darwin 以外のプラットフォームでは C ツールチェーンも必要になる。そのため、`CGO_ENABLED=0` のビルドでは使えない。

```yaml
- run: go test -race -parallel 4 ./...
```

`-parallel` のデフォルトは `GOMAXPROCS` だ。並列実行される各テストが実プロセスやファイルウォッチャーを起動する場合、このデフォルトのままでは、macOS ランナーのプロセスあたりのファイルディスクリプタ上限を使い切ってしまうことがある。明示的に上限を指定しておくべきだ。

### 見つかったもの

見つかった競合は、本番のロジックにはなかった。その周りを支える足場のコードに潜んでいた。一度もレースディテクタの下で実行されたことのないコードベースでは、典型的なパターンだ。

**ログの出力先として使われた `bytes.Buffer`。** テストがバッファをロガーに渡し、サーバーの goroutine がまだ書き込んでいる最中にそれを読み出す。`bytes.Buffer` は並行利用に対して安全ではない。ラップする。

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

**テスト用フェイクのエクスポートされたフィールドを、テストの途中で書き換える。** `Hold bool` を持つフェイクを生成時に設定し、フェイクを実行している goroutine がそれを読んでいる間に、テストが `fake.Hold = false` を代入する。フィールドをフェイク自身の mutex の内側に移してメソッドとして公開すれば、ロックを迂回できなくなる。

```go
type fakeRunner struct {
	mu   sync.Mutex
	hold bool
}

// SetHold は Run が解放を待つかどうかを切り替える。メソッドチェーンでセットアップを簡潔に書ける。
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

**起動時に代入されるパッケージレベル変数。** グローバル変数に代入する `SetLogger` は、一度しか起動しないプロセスなら問題ない。しかし、デーモンを何度も起動するテストバイナリでは、前のインスタンスのバックグラウンド goroutine がまだ読んでいる間に代入が起こる。`atomic.Pointer` を使えば、ホットパスに mutex を置かずに安全に差し替えられる。

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

3 つとも根本原因は同じで、同期の責任が呼び出し側に委ねられていたことだ。恒久的な対策は、状態を所有する型の内側にロックを置くことである。そのロックの内側から、内部の map や slice への参照を返してはならない。`maps.Clone` などでコピーを返す。

`//go:build !race` でテストを race ビルドから除外してよいのは、レースディテクタによる速度低下がタイミングのアサーションを壊す場合に限られる。実際の報告を隠すために使ってはならない。

## 3. サブプロセスの寿命を制御する

### 判断：読み取りは呼び出し元に従い、書き込みは完了させる

`git` を呼び出すデーモンには、呼び出し元がいなくなったときに子プロセスをどう扱うかの方針が必要だ。私が最終的に落ち着いたのは、コマンドが何をするかで扱いを分ける方針である。

- **読み取り専用のコマンド**（`status`、`log`、`diff`、`rev-parse`、`grep`）は、呼び出し元の `context.Context` に紐付ける。HTTP クライアントが切断したり、デーモンがシャットダウンしたりすれば、子プロセスは kill される。もう誰もその結果を必要としていないからだ。
- **状態を変更するコマンド**（`commit`、`checkout`、`worktree add`、`config` の書き込み）は、独自のタイムアウトの下で最後まで実行する。呼び出し元がいなくなったからといって、作りかけの worktree や残された `index.lock` を放置してよい理由にはならない。
- **すべてのコマンド**には、それとは別に上限のタイムアウトを設ける。credential helper やネットワークファイルシステム、残ったロックで固まった git プロセスは、止まったままの goroutine ではなく、報告可能なエラーになるべきだ。

### 仕組みと、その限界

`exec.CommandContext` は、context が終了すると `cmd.Cancel` を呼ぶ。デフォルトではこれは `Process.Kill` で、Unix では `SIGKILL` になる。これが届くのは**直接の子プロセスだけ**だ。`git fetch` は `ssh` や credential helper を起動し、それらの孫プロセスは生き残る。孫プロセスが子の stdout を引き継いでいると、`Wait` がブロックする。パイプをコピーしている goroutine は EOF を待っており、EOF は書き込み側を保持しているすべてのプロセスが終了するまで来ないからだ。

これに対処する仕組みは 2 つあり、組み合わせて使える（`Cancel` と `WaitDelay` は Go 1.20 以降が必要）。

- `cmd.WaitDelay` は、キャンセル後（あるいは子プロセスの終了後）に `Wait` がどれだけ待つかの上限を決める。上限を超えるとパイプを強制的に閉じて戻る。保証されるのは `Wait` が戻ることであって、プロセスが消えることではない。
- プロセスグループとカスタムの `Cancel` を組み合わせると、シグナルをツリー全体に届けられる。

```go
//go:build unix

func commandInGroup(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// 負の pid を指定すると、プロセスグループ全体にシグナルが送られる。
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
```

これにはトレードオフがある。`Setpgid` は子プロセスを端末のフォアグラウンドプロセスグループから外すので、対話的な `Ctrl-C` が届かなくなる。デーモンならそれで正しいが、TTY を中継する CLI では正しくない。グレースフルな終了を許すために `Cancel` で `SIGTERM` を送る場合は、`WaitDelay` 経過後のエスカレーションがグループリーダーに対する `Process.Kill` だけであることに注意が必要だ。Windows で同じ保証を得るには Job Object が必要になる。読み取り専用のコマンドなら後始末するものが何もないので、グループへの `SIGKILL` が妥当なデフォルトだ。

### git を非対話的に、パースしやすくする

```go
cmd.Env = append(cmd.Environ(),
	"GIT_TERMINAL_PROMPT=0", // 認証情報の入力を求めずに失敗させる
	"GIT_OPTIONAL_LOCKS=0",  // 読み取りで index.lock を取らない
)
// -c core.quotepath=off で、非 ASCII のパスを 8 進エスケープせずそのまま出力する。
```

微妙なのは `GIT_OPTIONAL_LOCKS=0` のほうだ。デフォルトでは、`git status` は機会があればインデックスをリフレッシュし、そのために `index.lock` を取得する。別のプロセスが同じワーキングツリーでコミットしていると、どちらかが "index.lock exists" で失敗する。読み取りの経路が、書き込みの経路とこのロックを奪い合うことがあってはならない。

stdout は戻り値として、stderr はエラーの中に保持する。git が成功に至る途中で出力した警告が、パースされた SHA に紛れ込むことがあってはならない。終了ステータスを解釈する前に `ctx.Err()` を確認し、キャンセルが `signal: killed` ではなくキャンセルとして報告されるようにする。"not a git repository" や unborn な `HEAD` といった既知の stderr のパターンは 1 か所でセンチネルエラーに対応付け、呼び出し側が文字列比較ではなく `errors.Is` を使えるようにしておく。

### 事例：ツールのフォールバックによる全文検索

ワーキングコピーに対する内容検索は、再実装するのではなく、それを得意とする既存のツールに任せるべきだ。フォールバックの順序は `rg`、`git grep`、`grep` とする。それぞれのツールには、無視できない挙動の違いがある。

- **`rg`** は `.gitignore` を尊重し、隠しファイルとバイナリファイルをスキップする。`--hidden` を付けて `.github/` のような dotfile も検索対象にし、そのうえで `.git/` を glob で明示的に除外する。`--json` を使えば、曖昧さのない構造化出力が得られる。
- **`git grep`** はワークツリーの中でしか動かない。`git rev-parse --is-inside-work-tree` で確認し、結果が `true` でなければ次のツールに回す。`--untracked` を付けると、未追跡かつ無視されていないファイルも対象になる。`-z` を使えば、コロンを含むパスも曖昧にならない。
- **`grep -r`** は ignore ファイルについて何も知らない。`.git` や `node_modules` などには `--exclude-dir` を渡す。`--null` は GNU grep と BSD grep の両方で使える。

どのツールでもリテラルマッチ（`-F` / `--fixed-strings`）を使い、パターンはオプションの後に `-e` で渡し、パスの前には `--` を置く。そうしないと、`-` で始まるユーザーのクエリがフラグとして解釈されてしまう。各バイナリのパスは `sync.OnceValue(func() string { p, _ := exec.LookPath("rg"); return p })` で一度だけ解決する。

ランナーが正しく扱うべきことは 3 つある。並行数の制限、結果件数の上限、そして意図的な停止とキャンセルの区別だ。

```go
var searchSlots = make(chan struct{}, 3) // rg 自体がすでに複数コアに処理を分散する

func runSearch(ctx context.Context, dir, bin string, args []string, limit int,
	parse func([]byte) (Match, bool)) ([]Match, bool, error) {
	select { // スロットを待つが、呼び出し元が諦めたらこちらも諦める
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
	sc.Buffer(nil, 1<<20) // バンドルされた JavaScript などの長い行を許容する
	for sc.Scan() {
		if len(matches) == limit {
			partial = true
			break
		}
		if m, ok := parse(sc.Bytes()); ok {
			matches = append(matches, m)
		}
	}
	cancel()                           // ツールをその場で止める
	_, _ = io.Copy(io.Discard, stdout) // Wait の前に読み切る
	waitErr := cmd.Wait()

	if err := caller.Err(); err != nil {
		return nil, false, err // 呼び出し元のキャンセルを 0 件ヒットに見せてはならない
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !partial && !(errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1) {
		return nil, false, waitErr // 3 つのツールいずれも、終了コード 1 は「一致なし」を意味する
	}
	return matches, partial, nil
}
```

末尾の順序が重要だ。`os/exec` のドキュメントには、`StdoutPipe` からの読み取りがすべて完了する前に `Wait` を呼ぶのは誤りだと明記されている。読み捨てているのはそのためだ。上限に達したときは意図的に context をキャンセルしているので、その結果の kill は失敗ではない。部分的な結果であり、レスポンスでもそう伝えるべきだ。呼び出し元に起因するキャンセルでは、context のエラーを返さなければならない。空の slice を返すと「何も一致しなかった」と読めてしまう。

`rg` と `grep` は、読めないファイルがあると、一致を出力していても終了ステータス 2 で終わる。権限エラーによる部分的な結果を許容できるかどうかは、ユースケースに応じて判断する必要がある。上のランナーでは、上限に達した場合を除き、これを失敗として扱っている。

## 4. bootout の競合を避けて launchd サービスを再登録する

### 障害のパターン

macOS の LaunchAgent をその場でアップグレードするには、plist を書き換えてサービスをリロードする。

```text
launchctl bootout   gui/501/com.example.agent
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.example.agent.plist
```

この 2 つを続けて実行すると、2 つ目のコマンドがときどき失敗する。

```text
Bootstrap failed: 5: Input/output error
```

`bootout` は、後片付けが完了する前に応答を返す。launchd は `SIGTERM` を送り、ジョブの `ExitTimeOut` まで待ってから `SIGKILL` にエスカレーションし、ドメインからのサービスの削除は非同期に行う。その間に同じラベルを `bootstrap` すると `EIO` が返る。厄介なのはその後だ。`bootout` 自体は成功しているので、launchd はジョブが正常にアンロードされたとみなし、`KeepAlive` はそれを復活させない。再起動で済むはずのアップグレードで、サービスが停止したままになる。

### 消えるのを待ち、上限付きでリトライする

```go
func bootout(target string) {
	_ = exec.Command("launchctl", "bootout", target).Run() // ロードされていなくても問題ない
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		// ラベルがドメインから消えると、print は非ゼロで終了する。
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
		time.Sleep(time.Duration(attempt) * 300 * time.Millisecond) // 線形バックオフ
	}
	return fmt.Errorf("launchctl bootstrap %s: %w: %s", plist, err, bytes.TrimSpace(out))
}
```

一般的なケースはポーリングで対応できる。リトライは、ラベルが `print` から消えてから launchd が再び受け付けられる状態になるまでの、残りの隙間をカバーする。リトライには上限が必要だ。`EIO` はこの競合に固有のエラーではなく、plist の不備やパスの誤りでも同じエラーが出るからだ。リトライの対象を `Input/output error` という文字列に絞れば、それ以外の失敗は早く表面化する。いずれにせよ、plist は事前に検証し（`plutil -lint`）、最後の出力をエラーに含めておく。

### 再起動のセマンティクスも定義の一部である

`KeepAlive` に `Crashed = true` を指定すると、`SIGSEGV` のようなクラッシュシグナルで死んだ場合にのみジョブが再起動される。スーパーバイザーに再起動させる目的などで、意図的に非ゼロのステータスで終了したプロセスは再起動されない。その場合は `SuccessfulExit = false` を使う。こちらは非ゼロで終了すれば必ず再起動する。launchd は再起動の頻度も抑制する（`ThrottleInterval`、デフォルトは 10 秒）ので、クラッシュループは空回りせず、ペースが落ちるだけで済む。systemd で相当するのは `Restart=on-failure` だ。

これはアップグレードの際に効いてくる。古いインストールには、誤った再起動ポリシーや古いバイナリパスを含む定義が残っているかもしれない。アップグレードのたびに、現行バージョンが書き出すはずの定義を生成してインストール済みのものと比較し、異なれば再登録する。この操作は冪等で、別途マイグレーションの手順を用意しなくても、古いインストールが修正される。

systemd には同じ競合はない。`systemctl stop` や `restart` は、`--no-block` を指定しない限りジョブの完了を待つ。systemd でよくある失敗は、unit を変更した後の `systemctl --user daemon-reload` を忘れることと、ログインセッションなしで user unit が動くと期待してしまうことだ。後者には `loginctl enable-linger` が必要になる。

## 5. PostgreSQL：`FOR UPDATE` と `FOR NO KEY UPDATE`

### 課題

親行の状態遷移を直列化する一般的な方法は、`SELECT ... FOR UPDATE` で読み、判断し、書き込むことだ。しかしこうすると、状態遷移は**外部キーで親を参照する行を挿入または更新した、実行中のすべてのトランザクション**を待つことになる。逆も同じで、親がロックされている間は、そうした子の書き込みが待たされる。どの操作も親のキーを変更しないにもかかわらず、更新の集中する親行ではロックの渋滞（lock convoy）が起きる。

### 仕組み

子の側の外部キーチェックはシステムトリガーとして実装されており、実質的に `SELECT 1 FROM ONLY parent WHERE pk = $1 FOR KEY SHARE` を実行する。これは挿入した文の終わり（遅延制約ならコミット時）に実行され、ロックは子のトランザクションが終わるまで保持される。`FOR KEY SHARE` は、参照先のキーが子の知らないうちに削除・変更されないことを保証する。[行レベルロックの競合表](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)によれば、これが競合するモードは `FOR UPDATE` だけだ。

| 要求 \ 保持       | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|-------------------|-----------|-------|---------------|--------|
| FOR KEY SHARE     |           |       |               | X      |
| FOR SHARE         |           |       | X             | X      |
| FOR NO KEY UPDATE |           | X     | X             | X      |
| FOR UPDATE        | X         | X     | X             | X      |

行ロックは、共有のロックテーブルではなくタプルヘッダ（`xmax`）に記録される。並行する FK チェックのように、複数のトランザクションが 1 つの行に共有ロックを保持している場合、PostgreSQL はそれを MultiXact として記録する。通常の `SELECT` がこれらを待つことは一切ない。MVCC の読み取りは行ロックを取らないからだ。

この修正を安全なものにしているのは、次の点だ。キー列を変更しない `UPDATE` は、それ自体がすでに `FOR NO KEY UPDATE` を取得している。ここで PostgreSQL の言う「キー列」とは、外部キーから参照できる一意インデックスに含まれる列のことで、部分インデックスや式インデックスは含まない。したがって、そうした更新の前に明示的に取る `FOR UPDATE` は**後に続く書き込みよりも強い**ことになり、その余分な強さは FK チェックとの競合以外に何ももたらさない。

### 修正

例では次のスキーマを使う。

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

`FOR NO KEY UPDATE` は自分自身とは競合するので、同じ行に対する 2 つの状態遷移は引き続き直列化される。一方で `FOR KEY SHARE` とは競合しないので、子の挿入は待たずに進める。psycopg 3 では次のようになる。

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
                return "already_closed"  # 冪等な再実行
            await cur.execute(
                "UPDATE orders SET status = 'closed', closed_at = now() WHERE id = %s",
                (order_id,),
            )
            return "closed"
```

### タイミングではなくロックをテストする

ロックの挙動をタイミングでテストすると、どちらの方向にも不安定になる。`lock_timeout` を使えば、「待たされたはず」を決定的な `LockNotAvailable` エラー（SQLSTATE `55P03`）に変えられる。子の行を挿入した未完了のトランザクションで `FOR KEY SHARE` を保持したまま、短い `lock_timeout` の下で対象の操作を実行する。

```python
import asyncio

import pytest
from psycopg import AsyncConnection
from psycopg.errors import LockNotAvailable

DSN = "postgresql://localhost/test"
# `order_id` は、open 状態の注文を挿入してその id を yield する pytest の fixture。


async def hold_fk_share(order_id: int, release: asyncio.Event) -> None:
    async with await AsyncConnection.connect(DSN) as conn:
        await conn.execute(
            "INSERT INTO order_items (order_id, sku) VALUES (%s, 'X')", (order_id,)
        )
        await release.wait()  # トランザクションと、その KEY SHARE を開いたままにする
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

ネガティブコントロールは省略できない。これがなければ、ポジティブ側のテストは、コードがどのロックモードを使っていても通ってしまう。空いているロックがタイムアウトに達することはないからだ。3 つ目のテストとして、並行する 2 つの状態遷移が引き続き直列化されることも検証すべきだ。そもそもロックは、その性質のためにあったのだから。

### 弱めるべきでないとき

- **トランザクションがその行を削除する、またはキーを変更する場合。** これらの文はいずれにせよ `FOR UPDATE` を取る。先に弱いロックを取ると後でアップグレードが必要になり、ロックのアップグレードはデッドロックの典型的な原因だ。PostgreSQL のドキュメントも、必要になる最も制限の強いモードを最初に取得するよう勧めている。
- **子の挿入をブロックすることが意図である場合。** たとえば「注文の確定処理中は新しい明細行を追加させない」といったケースだ。弱いロックにすると、その保証は黙って失われる。ロックモードの副作用に頼るのではなく、子の書き込み経路でのステータスチェックや制約によって、意図を明示的に表現する。
- **そもそも「読んで、判断して、書く」ロジックがない場合。** `UPDATE orders SET status = 'closed' WHERE id = %s AND status <> 'closed' RETURNING id` のような条件付きの単一の更新文には、明示的なロックは不要だ。暗黙に `FOR NO KEY UPDATE` を取るうえ、ロックを保持し続けるべき独立した読み取りの段階もない。

## まとめ

5 つの問題は、いずれも同じ過ちが異なる層で現れたものだ。

* レビューコメントの中にしか存在しない lint ルール
* 呼び出し側に委ねられた同期の責任
* 自分を起動したリクエストよりも長生きするサブプロセス
* 直前のコマンドが戻ったことを理由に、不要とみなされたリトライ
* 保護対象の書き込みよりも強い行ロック

対策には共通の原則がある。**強さと寿命を操作に見合ったものにし、正しい振る舞いを決定的かつ機械的に検査できるものにする。** 新しいコードだけをゲートし、残りは段階的に解消する。変更のたびにレースディテクタを走らせる。キャンセル時はプロセスツリー全体を kill し、書き込みは完了させる。bootstrap の前に、後片付けが完了したことを実際に観測できるまで待つ。直列化すべきものを直列化できる範囲で最も弱い行ロックを取り、より強いロックの下では失敗するテストでそれを証明する。
