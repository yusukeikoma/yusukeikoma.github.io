---
title: "Go デーモンと Python API の堅牢化"
date: 2026-09-26T19:00:00+09:00
draft: false
tags: ["go", "python", "postgresql", "concurrency", "macos"]
summary: "複数言語が同居するコードベースで得た 5 つの手法をまとめます。既存の Go コードへの golangci-lint の段階導入、CI でのレースディテクタの常時実行、サブプロセスの寿命の制御、bootout の競合を避けた launchd サービスの再登録、そして外部キーを踏まえた PostgreSQL の行ロック強度の選び方です。"
math: false
isCJKLanguage: true
---

# Go デーモンと Python API の堅牢化：Lint、データ競合、サブプロセス、launchd、行ロック

私が携わっているコードベースは、複数の言語が同居するモノレポです。常駐する Go のデーモンとその CLI が、PostgreSQL をバックエンドとする Python の API と並んでいます。

本稿では、このコードベースでの最近の作業から得た 5 つの手法をまとめます。互いに直接の関係はありませんが、根底にある考え方は共通しています。本番で起きる問題の多くは、必要以上に強い、長命な、あるいは非決定的な何かに起因する、ということです。それはロックであることもあれば、プロセスやリトライ、あるいはレビューコメントの中にしか存在しないルールであることもあります。

## 1. 既存のコードベースに Go のスタイルガイドを適用する

### 課題

レビューコメントの中にしか存在しない規約はスケールしません。レビュアーは同じ指摘を繰り返し、ルールは少しずつぶれていき、新しく加わったメンバーはそもそもルールが何なのかを知る手段がありません。定番の解決策は linter を有効にすることですが、既存のコードベースでは別の理由でうまくいきません。初回の実行で大量の指摘が一度に出て、その指摘の山を前に結局 linter が無効化されてしまうのです。

### 設計：すべてのルールに出典を示し、機械的に検査できるかどうかで分ける

ガイドは、すべてのルールが公開された出典を参照するように書きました。[Effective Go](https://go.dev/doc/effective_go)、[Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)、[Google](https://google.github.io/styleguide/go/) と [Uber](https://github.com/uber-go/guide) のスタイルガイド、そして [Go Proverbs](https://go-proverbs.github.io/) です。出典のあるルールなら、議論は「これは誰の好みか」から「これはこのケースに当てはまるか」に移ります。

そのうえで、各ルールを機械的に検査できるものと、判断を要するものに分類します。linter の設定に入れるのは前者だけです。linter の各エントリには、それが担保するルールを明記しておきます。命名やパッケージ境界のような判断を要するルールはレビューに残します。これを linter に載せても、ノイズが増えて `//nolint` が散乱するだけです。

```yaml
# .golangci.yml (golangci-lint v2)
version: "2"

linters:
  enable:
    - containedctx    # struct のフィールドに context.Context を持たせません
    - contextcheck    # 呼び出し元の context を伝播し、新たに作りません
    - errorlint       # %w でラップし、== や型 switch ではなく errors.Is/As を使います
    - gocyclo
    - gocognit        # gocyclo が考慮しないネストの深さを重み付けします
    - interfacebloat
    - nestif
    - nolintlint      # すべての抑制に linter 名と理由を明記させます
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

1 つだけ説明が必要なエントリがあります。`ST1005` は、エラー文字列を小文字で始めることを求めるチェックです。これは固有名詞やエクスポートされた識別子と、普通の単語とを区別できません。エラーメッセージがプロダクト名やツール名で始まるコードベースでは、抑制コメントをばらまくか、メッセージの質を落とすかの二択を迫られます。そこでこのチェックは無効にし、ルール自体はレビュー項目として残しました。あるチェックを全面的に有効にする前に、それが実際に何を報告するのかを確認しておくべきです。

### 導入：まず新しいコードをゲートし、既存の違反はパッケージ単位で解消する

`issues.new-from-merge-base` は、ターゲットブランチとのマージベース以降に持ち込まれた指摘だけを報告します。これにより、初日から新しいコードには準拠を求めつつ、既存のコードには手を付けずに済みます。`new-from-rev` ではなく、こちらを選んでください。`origin/main` のようなリビジョンは動き続ける先端であり、ベースブランチが自分の分岐点より先に進むと、それとの差分には他人の変更が含まれ、他人の指摘まで報告されてしまいます。マージベースは動きません。ただし、CI のチェックアウトには全履歴が必要になります（`actions/checkout` の `fetch-depth: 0`）。shallow clone ではマージベースを計算できないからです。

既存の違反は、その後パッケージ単位で 1 つずつ取り除いていきます。まだ直せない関数には、`//nolint:gocyclo // pre-existing; tracked for refactor` のように個別の抑制を付けます。`nolintlint` があれば、すべての例外が grep で見つかり、理由も付いています。解消作業は、それらの行を消していくだけの話になります。レガシーの抑制が 1 つも残らなくなったら、`new-from-merge-base` を外してツリー全体を lint します。

リファクタリングそのものについても触れておきます。長い関数の循環的複雑度が高くなる原因は、ほぼ決まった数パターンに収まります。`switch` がすべての case の本体をインラインで抱えている、エラー処理がネストしたブロックの中で正常系と交互に現れる、複数のフェーズ（準備、実行、後処理）が 1 つの関数本体を共有している、といったパターンです。フェーズをメソッドに、インライン化された case をディスパッチテーブルに切り出せば、ほとんどは解消します。落とし穴は、引数が 7 つもあるヘルパーを切り出してしまうことです。それは、ヘルパー間で共有している状態を小さな struct にまとめるべきか、フェーズの切り方が間違っているかのどちらかを意味します。振る舞いを変えない切り出しは、振る舞いを変えるコミットとは別のコミットにしておきましょう。

すべての関数を無理に閾値以下に収める必要はありません。単一の `switch` が仕様をそのまま写しているパーサやプロトコルのステートマシンは、1 つの関数のままのほうが仕様と照らし合わせやすくなります。理由付きの `//nolint` は、まさにこういうときのためにあります。

### lint の先へ：`go/parser` によるアーキテクチャテスト

構造に関するルールの中には、どの linter もカバーしていないものがあります。たとえば、internal 配下のすべてのパッケージは自身の境界をドキュメント化しなければならない、あるいは特定のサービス型はインターフェース越しにしかパッケージ境界をまたいではならない、といったルールです。こうしたルールは、ソースツリーをパースする普通のテストとして安価に強制できます。

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

// internal/ 配下のすべてのパッケージは、パッケージコメントで自身の役割を説明します。
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

同じ手法で、`ast.StructType` と `ast.FuncType` のノードを走査し、セレクタ式をファイルの import を通じて解決すれば、パッケージをまたいで「具象型ではなくインターフェースを保持する」ことを強制できます。既知の例外は明示的な許可リストで管理し、許可リストのエントリが不要になったらテストが失敗するようにしておきます。そうすれば、リストは縮む一方になります。

## 2. すべての CI 実行でレースディテクタを走らせる

### 判断

[レースディテクタ](https://go.dev/doc/articles/race_detector)は、実行中に実際に発生したデータ競合しか報告しません。適切なインターリーブで実行されなかった経路上の競合は見逃されます。そのため、ローカルでたまに `-race` を付けて実行する程度では、ほとんど意味がありません。レースディテクタが元を取れるのは、変更のたびにテストスイート全体をその下で実行した場合だけです。

多くのチームを思いとどまらせるのは、ドキュメントに記載されたコスト、つまり実行時間で 2〜20 倍、メモリで 5〜10 倍というオーバーヘッドです。ただし、このオーバーヘッドはメモリアクセスと同期処理の計装から生じます。サブプロセス、ソケット、タイマーの待ち時間が大半を占めるテストスイートなら、CPU バウンドなものよりはるかに負担は小さくなります。判断する前に、最も重いパッケージで計測してみるとよいでしょう。もう 1 つの必須要件は cgo で、Darwin 以外のプラットフォームでは C ツールチェーンも必要になります。そのため、`CGO_ENABLED=0` のビルドでは使えません。

```yaml
- run: go test -race -parallel 4 ./...
```

`-parallel` のデフォルトは `GOMAXPROCS` です。並列実行される各テストが実プロセスやファイルウォッチャーを起動する場合、このデフォルトのままでは、macOS ランナーのプロセスあたりのファイルディスクリプタ上限を使い切ってしまうことがあります。明示的に上限を指定しておきましょう。

### 見つかったもの

見つかった競合は、本番のロジックにはありませんでした。その周りを支える足場のコードに潜んでいたのです。一度もレースディテクタの下で実行されたことのないコードベースでは、典型的なパターンです。

**ログの出力先として使われた `bytes.Buffer`。** テストがバッファをロガーに渡し、サーバーの goroutine がまだ書き込んでいる最中にそれを読み出します。`bytes.Buffer` は並行利用に対して安全ではありません。ラップしましょう。

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

**テスト用フェイクのエクスポートされたフィールドの、テスト途中での書き換え。** `Hold bool` を持つフェイクを生成時に設定し、フェイクを実行している goroutine がそれを読んでいる間に、テストが `fake.Hold = false` を代入します。フィールドをフェイク自身の mutex の内側に移してメソッドとして公開すれば、ロックを迂回できなくなります。

```go
type fakeRunner struct {
	mu   sync.Mutex
	hold bool
}

// SetHold は Run が解放を待つかどうかを切り替えます。メソッドチェーンでセットアップを簡潔に書けます。
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

**起動時に代入されるパッケージレベル変数。** グローバル変数に代入する `SetLogger` は、一度しか起動しないプロセスなら問題ありません。しかし、デーモンを何度も起動するテストバイナリでは、前のインスタンスのバックグラウンド goroutine がまだ読んでいる間に代入が起こります。`atomic.Pointer` を使えば、ホットパスに mutex を置かずに安全に差し替えられます。

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

3 つとも根本原因は同じで、同期の責任が呼び出し側に委ねられていたことです。恒久的な対策としては、状態を所有する型の内側にロックを置きます。そのロックの内側から、内部の map や slice への参照を返してはいけません。`maps.Clone` などでコピーを返しましょう。

`//go:build !race` でテストを race ビルドから除外してよいのは、レースディテクタによる速度低下がタイミングのアサーションを壊す場合に限られます。実際の報告を隠すために使ってはいけません。

## 3. サブプロセスの寿命を制御する

### 判断：読み取りは呼び出し元に従い、書き込みは完了させる

`git` を呼び出すデーモンには、呼び出し元がいなくなったときに子プロセスをどう扱うかの方針が必要です。最終的に私は、コマンドが何をするかで扱いを分ける方針に落ち着きました。

- **読み取り専用のコマンド**（`status`、`log`、`diff`、`rev-parse`、`grep`）は、呼び出し元の `context.Context` に紐付けます。HTTP クライアントが切断したり、デーモンがシャットダウンしたりすれば、子プロセスは kill されます。もう誰もその結果を必要としていないからです。
- **状態を変更するコマンド**（`commit`、`checkout`、`worktree add`、`config` の書き込み）は、独自のタイムアウトの下で最後まで実行します。呼び出し元がいなくなったからといって、作りかけの worktree や残された `index.lock` を放置してよい理由にはなりません。
- **すべてのコマンド**には、それとは別に上限のタイムアウトを設けます。credential helper やネットワークファイルシステム、残ったロックで固まった git プロセスは、止まったままの goroutine ではなく、報告可能なエラーになるべきです。

### 仕組みと、その限界

`exec.CommandContext` は、context が終了すると `cmd.Cancel` を呼びます。デフォルトではこれは `Process.Kill` で、Unix では `SIGKILL` になります。これが届くのは**直接の子プロセスだけ**です。`git fetch` は `ssh` や credential helper を起動し、それらの孫プロセスは生き残ります。孫プロセスが子の stdout を引き継いでいると、`Wait` がブロックします。パイプをコピーしている goroutine は EOF を待っており、EOF は書き込み側を保持しているすべてのプロセスが終了するまで来ないからです。

これに対処する仕組みは 2 つあり、組み合わせて使えます（`Cancel` と `WaitDelay` は Go 1.20 以降が必要です）。

- `cmd.WaitDelay` は、キャンセル後（あるいは子プロセスの終了後）に `Wait` がどれだけ待つかの上限を決めます。上限を超えるとパイプを強制的に閉じて戻ります。保証されるのは `Wait` が戻ることであって、プロセスが消えることではありません。
- プロセスグループとカスタムの `Cancel` を組み合わせると、シグナルをツリー全体に届けられます。

```go
//go:build unix

func commandInGroup(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// 負の pid を指定すると、プロセスグループ全体にシグナルが送られます。
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
```

これにはトレードオフがあります。`Setpgid` は子プロセスを端末のフォアグラウンドプロセスグループから外すので、対話的な `Ctrl-C` が届かなくなります。デーモンならそれで正しいのですが、TTY を中継する CLI では正しくありません。グレースフルな終了を許すために `Cancel` で `SIGTERM` を送る場合は、`WaitDelay` 経過後のエスカレーションがグループリーダーに対する `Process.Kill` だけであることに注意が必要です。Windows で同じ保証を得るには Job Object が必要になります。読み取り専用のコマンドなら後始末するものが何もないので、グループへの `SIGKILL` が妥当なデフォルトです。

### git を非対話的に、パースしやすくする

```go
cmd.Env = append(cmd.Environ(),
	"GIT_TERMINAL_PROMPT=0", // 認証情報の入力を求めずに失敗させます
	"GIT_OPTIONAL_LOCKS=0",  // 読み取りで index.lock を取りません
)
// -c core.quotepath=off で、非 ASCII のパスを 8 進エスケープせずそのまま出力します。
```

微妙なのは `GIT_OPTIONAL_LOCKS=0` のほうです。デフォルトでは、`git status` は機会があればインデックスをリフレッシュし、そのために `index.lock` を取得します。別のプロセスが同じワーキングツリーでコミットしていると、どちらかが "index.lock exists" で失敗します。読み取りの経路が、書き込みの経路とこのロックを奪い合うことがあってはなりません。

stdout は戻り値として、stderr はエラーの中に保持します。git が成功に至る途中で出力した警告を、パースされた SHA に紛れ込ませてはいけません。終了ステータスを解釈する前に `ctx.Err()` を確認し、キャンセルが `signal: killed` ではなくキャンセルとして報告されるようにします。"not a git repository" や unborn な `HEAD` といった既知の stderr のパターンは 1 か所でセンチネルエラーに対応付け、呼び出し側が文字列比較ではなく `errors.Is` を使えるようにしておきます。

### 事例：ツールのフォールバックによる全文検索

ワーキングコピーに対する内容検索は、再実装するのではなく、それを得意とする既存のツールに任せるべきです。フォールバックの順序は `rg`、`git grep`、`grep` とします。それぞれのツールには、無視できない挙動の違いがあります。

- **`rg`** は `.gitignore` を尊重し、隠しファイルとバイナリファイルをスキップします。`--hidden` を付けて `.github/` のような dotfile も検索対象にし、そのうえで `.git/` を glob で明示的に除外します。`--json` を使えば、曖昧さのない構造化出力が得られます。
- **`git grep`** はワークツリーの中でしか動きません。`git rev-parse --is-inside-work-tree` で確認し、結果が `true` でなければ次のツールに回します。`--untracked` を付けると、未追跡かつ無視されていないファイルも対象になります。`-z` を使えば、コロンを含むパスも曖昧になりません。
- **`grep -r`** は ignore ファイルについて何も知りません。`.git` や `node_modules` などには `--exclude-dir` を渡します。`--null` は GNU grep と BSD grep の両方で使えます。

どのツールでもリテラルマッチ（`-F` / `--fixed-strings`）を使い、パターンはオプションの後に `-e` で渡し、パスの前には `--` を置きます。そうしないと、`-` で始まるユーザーのクエリがフラグとして解釈されてしまいます。各バイナリのパスは `sync.OnceValue(func() string { p, _ := exec.LookPath("rg"); return p })` で一度だけ解決します。

ランナーが正しく扱うべきことは 3 つあります。並行数の制限、結果件数の上限、そして意図的な停止とキャンセルの区別です。

```go
var searchSlots = make(chan struct{}, 3) // rg 自体がすでに複数コアに処理を分散します

func runSearch(ctx context.Context, dir, bin string, args []string, limit int,
	parse func([]byte) (Match, bool)) ([]Match, bool, error) {
	select { // スロットを待ちますが、呼び出し元が諦めたらこちらも諦めます
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
	sc.Buffer(nil, 1<<20) // バンドルされた JavaScript などの長い行を許容します
	for sc.Scan() {
		if len(matches) == limit {
			partial = true
			break
		}
		if m, ok := parse(sc.Bytes()); ok {
			matches = append(matches, m)
		}
	}
	cancel()                           // ツールをその場で止めます
	_, _ = io.Copy(io.Discard, stdout) // Wait の前に読み切ります
	waitErr := cmd.Wait()

	if err := caller.Err(); err != nil {
		return nil, false, err // 呼び出し元のキャンセルを 0 件ヒットに見せてはいけません
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !partial && !(errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1) {
		return nil, false, waitErr // 3 つのツールいずれも、終了コード 1 は「一致なし」を意味します
	}
	return matches, partial, nil
}
```

末尾の順序が重要です。`os/exec` のドキュメントには、`StdoutPipe` からの読み取りがすべて完了する前に `Wait` を呼ぶのは誤りだと明記されています。読み捨てているのはそのためです。上限に達したときは意図的に context をキャンセルしているので、その結果の kill は失敗ではありません。部分的な結果であり、レスポンスでもそう伝えるべきです。呼び出し元に起因するキャンセルでは、context のエラーを返さなければなりません。空の slice を返すと「何も一致しなかった」と読めてしまいます。

`rg` と `grep` は、読めないファイルがあると、一致を出力していても終了ステータス 2 で終わります。権限エラーによる部分的な結果を許容できるかどうかは、ユースケースに応じて判断する必要があります。上のランナーでは、上限に達した場合を除き、これを失敗として扱っています。

## 4. bootout の競合を避けて launchd サービスを再登録する

### 障害のパターン

macOS の LaunchAgent をその場でアップグレードするには、plist を書き換えてサービスをリロードします。

```text
launchctl bootout   gui/501/com.example.agent
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.example.agent.plist
```

この 2 つを続けて実行すると、2 つ目のコマンドがときどき失敗します。

```text
Bootstrap failed: 5: Input/output error
```

`bootout` は、後片付けが完了する前に応答を返します。launchd は `SIGTERM` を送り、ジョブの `ExitTimeOut` まで待ってから `SIGKILL` にエスカレーションし、ドメインからのサービスの削除は非同期に行います。その間に同じラベルを `bootstrap` すると `EIO` が返ります。厄介なのはその後です。`bootout` 自体は成功しているので、launchd はジョブが正常にアンロードされたとみなし、`KeepAlive` はそれを復活させません。再起動で済むはずのアップグレードで、サービスが停止したままになってしまいます。

### 消えるのを待ち、上限付きでリトライする

```go
func bootout(target string) {
	_ = exec.Command("launchctl", "bootout", target).Run() // ロードされていなくても問題ありません
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		// ラベルがドメインから消えると、print は非ゼロで終了します。
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

一般的なケースはポーリングで対応できます。リトライは、ラベルが `print` から消えてから launchd が再び受け付けられる状態になるまでの、残りの隙間をカバーします。リトライには上限が必要です。`EIO` はこの競合に固有のエラーではなく、plist の不備やパスの誤りでも同じエラーが出るからです。リトライの対象を `Input/output error` という文字列に絞れば、それ以外の失敗は早く表面化します。いずれにせよ、plist は事前に検証し（`plutil -lint`）、最後の出力をエラーに含めておきましょう。

### 再起動のセマンティクスも定義の一部

`KeepAlive` に `Crashed = true` を指定すると、`SIGSEGV` のようなクラッシュシグナルで死んだ場合にのみジョブが再起動されます。スーパーバイザーに再起動させる目的などで、意図的に非ゼロのステータスで終了したプロセスは再起動されません。その場合は `SuccessfulExit = false` を使います。こちらは非ゼロで終了すれば必ず再起動します。launchd は再起動の頻度も抑制する（`ThrottleInterval`、デフォルトは 10 秒）ので、クラッシュループは空回りせず、ペースが落ちるだけで済みます。systemd で相当するのは `Restart=on-failure` です。

これはアップグレードの際に効いてきます。古いインストールには、誤った再起動ポリシーや古いバイナリパスを含む定義が残っているかもしれません。アップグレードのたびに、現行バージョンが書き出すはずの定義を生成してインストール済みのものと比較し、異なれば再登録します。この操作は冪等で、別途マイグレーションの手順を用意しなくても、古いインストールが修正されます。

systemd には同じ競合はありません。`systemctl stop` や `restart` は、`--no-block` を指定しない限りジョブの完了を待ちます。systemd でよくある失敗は、unit を変更した後の `systemctl --user daemon-reload` を忘れることと、ログインセッションなしで user unit が動くと期待してしまうことです。後者には `loginctl enable-linger` が必要になります。

## 5. PostgreSQL：`FOR UPDATE` と `FOR NO KEY UPDATE`

### 課題

親行の状態遷移を直列化する一般的な方法は、`SELECT ... FOR UPDATE` で読み、判断し、書き込むことです。しかしこうすると、状態遷移は**外部キーで親を参照する行を挿入または更新した、実行中のすべてのトランザクション**を待つことになります。逆も同じで、親がロックされている間は、そうした子の書き込みが待たされます。どの操作も親のキーを変更しないにもかかわらず、更新の集中する親行ではロックの渋滞（lock convoy）が起きます。

### 仕組み

子の側の外部キーチェックはシステムトリガーとして実装されており、実質的に `SELECT 1 FROM ONLY parent WHERE pk = $1 FOR KEY SHARE` を実行します。これは挿入した文の終わり（遅延制約ならコミット時）に実行され、ロックは子のトランザクションが終わるまで保持されます。`FOR KEY SHARE` は、参照先のキーが子の知らないうちに削除・変更されないことを保証します。[行レベルロックの競合表](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)によれば、これが競合するモードは `FOR UPDATE` だけです。

| 要求 \ 保持       | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|-------------------|-----------|-------|---------------|--------|
| FOR KEY SHARE     |           |       |               | X      |
| FOR SHARE         |           |       | X             | X      |
| FOR NO KEY UPDATE |           | X     | X             | X      |
| FOR UPDATE        | X         | X     | X             | X      |

行ロックは、共有のロックテーブルではなくタプルヘッダ（`xmax`）に記録されます。並行する FK チェックのように、複数のトランザクションが 1 つの行に共有ロックを保持している場合、PostgreSQL はそれを MultiXact として記録します。通常の `SELECT` がこれらを待つことは一切ありません。MVCC の読み取りは行ロックを取らないからです。

この修正を安全なものにしているのは、次の点です。キー列を変更しない `UPDATE` は、それ自体がすでに `FOR NO KEY UPDATE` を取得しています。ここで PostgreSQL の言う「キー列」とは、外部キーから参照できる一意インデックスに含まれる列のことで、部分インデックスや式インデックスは含みません。したがって、そうした更新の前に明示的に取る `FOR UPDATE` は**後に続く書き込みよりも強い**ことになり、その余分な強さは FK チェックとの競合以外に何ももたらしません。

### 修正

例では次のスキーマを使います。

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

`FOR NO KEY UPDATE` は自分自身とは競合するので、同じ行に対する 2 つの状態遷移は引き続き直列化されます。一方で `FOR KEY SHARE` とは競合しないので、子の挿入は待たずに進められます。psycopg 3 では次のようになります。

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

ロックの挙動をタイミングでテストすると、どちらの方向にも不安定になります。`lock_timeout` を使えば、「待たされたはず」を決定的な `LockNotAvailable` エラー（SQLSTATE `55P03`）に変えられます。子の行を挿入した未完了のトランザクションで `FOR KEY SHARE` を保持したまま、短い `lock_timeout` の下で対象の操作を実行します。

```python
import asyncio

import pytest
from psycopg import AsyncConnection
from psycopg.errors import LockNotAvailable

DSN = "postgresql://localhost/test"
# `order_id` は、open 状態の注文を挿入してその id を yield する pytest の fixture です。


async def hold_fk_share(order_id: int, release: asyncio.Event) -> None:
    async with await AsyncConnection.connect(DSN) as conn:
        await conn.execute(
            "INSERT INTO order_items (order_id, sku) VALUES (%s, 'X')", (order_id,)
        )
        await release.wait()  # トランザクションと、その KEY SHARE を開いたままにします
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

ネガティブコントロールは省略できません。これがなければ、ポジティブ側のテストは、コードがどのロックモードを使っていても通ってしまいます。空いているロックがタイムアウトに達することはないからです。3 つ目のテストとして、並行する 2 つの状態遷移が引き続き直列化されることも検証すべきです。そもそもロックは、その性質のためにあったのですから。

### 弱めるべきでないとき

- **トランザクションがその行を削除する、またはキーを変更する場合。** これらの文はいずれにせよ `FOR UPDATE` を取ります。先に弱いロックを取ると後でアップグレードが必要になり、ロックのアップグレードはデッドロックの典型的な原因です。PostgreSQL のドキュメントも、必要になる最も制限の強いモードを最初に取得するよう勧めています。
- **子の挿入をブロックすることが意図である場合。** たとえば「注文の確定処理中は新しい明細行を追加させない」といったケースです。弱いロックにすると、その保証は黙って失われます。ロックモードの副作用に頼るのではなく、子の書き込み経路でのステータスチェックや制約によって、意図を明示的に表現しましょう。
- **そもそも「読んで、判断して、書く」ロジックがない場合。** `UPDATE orders SET status = 'closed' WHERE id = %s AND status <> 'closed' RETURNING id` のような条件付きの単一の更新文には、明示的なロックは不要です。暗黙に `FOR NO KEY UPDATE` を取るうえ、ロックを保持し続けるべき独立した読み取りの段階もありません。

## まとめ

5 つの問題は、いずれも同じ過ちが異なる層で現れたものです。

* レビューコメントの中にしか存在しない lint ルール
* 呼び出し側に委ねられた同期の責任
* 自分を起動したリクエストよりも長生きするサブプロセス
* 直前のコマンドが戻ったことを理由に、不要とみなされたリトライ
* 保護対象の書き込みよりも強い行ロック

対策には共通の原則があります。**強さと寿命を操作に見合ったものにし、正しい振る舞いを決定的かつ機械的に検査できるものにすること。** 新しいコードだけをゲートし、残りは段階的に解消していきます。レースディテクタは変更のたびに走らせます。キャンセル時にはプロセスツリー全体を kill し、書き込みは完了させてください。bootstrap の前には、後片付けが完了したことを実際に観測できるまで待ちましょう。そして、直列化すべきものを直列化できる範囲で最も弱い行ロックを取り、より強いロックの下では失敗するテストでそれを証明します。
