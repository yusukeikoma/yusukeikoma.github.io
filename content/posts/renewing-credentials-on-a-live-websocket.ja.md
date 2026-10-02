---
title: "接続したままの WebSocket で資格情報を更新する"
date: 2026-10-02T16:40:00+09:00
draft: true
tags: ["websocket", "authentication", "go", "javascript"]
summary: "長く生きるソケットは、それを許可した短命の資格情報より長生きします。その場での更新は再接続と再購読を避けられますが、更新が接続に紐づき、延長しかできず、成功するのは最大1回で、あらゆる失敗が通常の再接続に落ちるときだけ安全です。"
math: false
isCJKLanguage: true
---

# 接続したままの WebSocket で資格情報を更新する

WebSocket が認証されるのは、HTTP のアップグレードのときの1回だけです。発行する価値のある資格情報は短命です。ソケットはそうではありません。遅かれ早かれ、接続を許可した資格情報は、接続が健全で忙しいまま期限切れになります。そのとき、接続を終えるか延ばすかを選ばなければなりません。

この記事では、延長を安全に行うためのパターンを扱います。特定のトークン形式、クレームの集合、有効期間については意図的に何も述べません。それらはデプロイごとに異なるもので、以下の構造はそれらに依存しないからです。

## 期限で再接続する方式と、それを避けたくなる理由

基本形は単純で正しい方式です。資格情報が切れる前にソケットを閉じ、新しい資格情報を取得し、再び接続します。サーバー側の対応が要らないので、何を作っても、これはフォールバックとして残すべきです。

ただ、システムが大きくなるにつれてコストが増えます。

- 進行中のストリームがすべて切れます。クライアントは気づいて再購読し、イベントの欠落を許容しなければなりません。
- 購読を永続化するリレーでは、再購読はメッセージのバーストです。従量課金なら、支払うバーストです。
- 再接続のロジックは状態機械です。通過する回数が増えるほど、競合に当たる機会も増えます。（そうした競合の1つは、*close イベントが来ないとき*の主題です。）

その場での更新は欠落をなくします。接続と購読はそのままで、動くのは認可の窓だけです。

## 新しい資格情報をどこに載せるか

アップグレードの後は、ソケットに新しいヘッダーを付けられません。選択肢は2つあります。

**ソケット上のメッセージ。** クライアントが「新しい資格情報はこれです」というフレームを送ります。単純ですが、資格情報の扱いがデータ経路に入り、ほかのすべてを処理するパーサーと同じ場所になります。また、このフレームはソケットが運んでいるほかのものと競合します。

**生きている接続を名指しする、別の認証済みリクエスト。** クライアントが同じサービスに普通の HTTP 呼び出しを行います。サーバー側の通常のリクエスト認証が動き、ハンドラが生きているソケットを探して、保持している状態を更新します。データ経路は資格情報を一切パースしません。

どちらも正しく作れます。以降は、すでに堅牢化された経路を再利用できる後者の形を前提にしますが、以下の性質はどちらにも当てはまります。

## 更新が備えるべき性質

更新エンドポイントは、寿命を延ばせる攻撃面として扱ってください。実際にそういうものだからです。

**同じ主体であること。** 新しい資格情報は、ソケットが許可された主体と同じものに属していなければなりません。他人の有効な資格情報は、このソケットの有効な更新ではありません。

**厳密に延長すること。** 新しい有効期限は、現在のものより後でなければなりません。短縮や、同じ値の繰り返しを許すと、ログから漏れた古い資格情報を再送して、状態を巻き戻せます。

**現在の状態に紐づくこと。** *直前*の資格情報も提示させ、それがまだ期限内で、ソケットを許可したものと同じであることを確かめます。これで更新は、単に有効な資格情報ではなく、現在のセッションを持っていることの証明になります。

**成功するのは最大1回であること。** 競合する2つの更新や、2回届いた同じ更新が、両方成功してはいけません。ソケットの状態に世代を持たせ、それに対して compare-and-swap を行います。リクエストは置き換えようとする世代を運び、勝つのは1つのリクエストだけです。Durable Objects では状態がソケットの隣にあるので、読み取りと書き込みの間で処理を明け渡さない限り、スワップは分散協調のない普通の read-modify-write です（ハイバネートをまたいでソケットごとの状態を保てる場所は、[WebSocket のベストプラクティス](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)にあります）。

サーバーの判断を、純粋関数として示します。トークン形式（`sub`、`gen`、`exp` を持つ署名付き JSON）は、例のために作ったものです。

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

ステータスコードは区別されています。「認証されていない」（401）、「認証はされているが、このソケットのものではない」（403）、「有効だが、いまは適用できない」（409。リプレイ、古い世代、延長にならない有効期限をカバーします）。409 を受け取ったクライアントは、試したこと自体が間違いではありません。競り負けただけで、フォールバックはほかのすべての失敗と同じです。

テストは各性質を別々に固定します。忘れやすいリプレイも含みます。

```js
test('the same renewal cannot be replayed', () => {
  const first = go();
  const again = go({ live: first.live });
  assert.equal(again.status, 409);
});
```

サーバーは、保存している有効期限を引き続き強制する必要もあります。更新が届かないソケットは、窓が終わった時点で閉じなければなりません。更新は期限を延ばすものであって、期限をなくすものではありません。

## クライアント: 安全でなければ何も送らない

呼び出し側は資格情報を持っていて、次のものをソース（トークンエンドポイント）から取得します。何かを送る前に、ローカルで確認できる性質を確かめます。同じ主体、同じエンドポイント、同じ鍵、厳密に後の有効期限です。

エンドポイントと鍵のチェックは、資格情報が何かだけでなく、どこへ行くかのためです。発行者が鍵をローテーションしたりエンドポイントを移したりしたなら、古いソケットには新しいものを渡すべきではありません。ソケットがたまたま指している先へ資格情報を送るよりも、新しい宛先を最初から解決する再接続の経路に落とすほうが安全です。

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

すべての失敗は1つのエラー `ErrReconnect` にまとまり、その意味は「更新が存在する前から動いていた経路を取る」です。拒否、404 を返す古いサーバー、競り負け、ネットワークエラー、ローテーションされた鍵は、すべてそれを意味します。この性質があるので、更新は安全にロールアウトできます。すでに動いている仕組みの上に載った最適化なので、失敗のしかたに新しいものがありません。

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

### タイミング

更新は、期限の前に再試行できるだけ早く始めなければならず、ハングしたリクエストが残りの窓を食いつぶさないよう、各試行にデッドラインが必要です。`Maintain` は期限の `lead` 前まで待ち、期限の `deadline` 前までを試行の持ち時間とし、失敗したら、古い資格情報がまだ有効なうちに呼び出し側が再接続できるよう戻ります。まだ有効な資格情報で始まる再接続には、空白がありません。

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

### 前提ではなく、能力として扱う

`supported` フラグは接続のハンドシェイクから来ます。アップグレードの応答で、サーバーがその場での更新を理解していると伝えます。これを見ていないクライアントは何も送らず、機能が存在する前と同じく期限の前に再接続します。テストはその強い形を確かめます。「無視されるリクエスト」ではなく、更新リクエストがゼロであることです。

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

これで、クライアントとサーバーをどちらの順でもリリースできます。エラーがないことから能力を推測してはいけません。

### 処理の途中にあるハンドラ

更新は、ほかの goroutine が使っている最中に資格情報を変えます。ハンドラがフィールドを1つずつ読むと、古いトークンと新しい有効期限を組み合わせてしまうかもしれません。コピーを渡してください。

```go
// Holder gives in-flight handlers a consistent snapshot while renewal swaps
// the credential. Handlers copy the value once and use the copy for the whole
// call; they never read fields of a shared struct that may change underneath.
type Holder struct {
	mu  sync.RWMutex
	cur Credential
}
```

ハンドラは `Snapshot()` を1回呼び、その値を操作の全体で使います。テストは、必ず一致していなければならない2つの値を切り替えながら、読み取り側を大量に走らせ、race detector の下で動かします。

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

## 使わないほうがよい場合

- **資格情報の寿命が、接続の寿命に比べて長い。** 接続がめったに資格情報より長生きしないなら、期限での再接続には最適化する価値のあるコストがありません。
- **再接続が安く、目に見えない。** カーソルから再開するステートレスなストリームは、再接続しても何も失いません。
- **失敗をフォールバックに落とせない。** 失敗した更新が、きれいな再接続ではなく中途半端に延長されたセッションを残すなら、その場での更新は、得られるものより危険です。
- **失効を即座に反映する必要がある。** 更新は失効を確認する機会の1つであって、失効の通知経路の代わりではありません。資格情報の寿命より速く失効を反映したいなら、失効時にサーバー側からソケットを閉じてください。

## 検証したことと、していないこと

サンプルは示したとおりにテストしています。サーバーの判断は `node:test`、クライアントは `go test -race` です。本番の変更は、SQLite をバックエンドにした Durable Objects を使い、Workers ランタイム上でローカルに動作確認もしています。実際のプラットフォームでの長時間のソークは行っていないため、本番で何度も更新を繰り返したときの挙動については何も主張しません。

## まとめ

- その場で更新すれば接続と購読が保たれます。期限での再接続は、フォールバックとして残します。
- 更新は、主体を保ち、有効期限を厳密に延ばし、直前の資格情報を提示し、compare-and-swap に最大1回だけ勝たなければなりません。
- クライアントは、主体、エンドポイント、鍵、有効期限がローカルですべて確認できたときだけ送ります。
- すべての失敗は「再接続」を意味する1つのエラーに集約します。対応状況はハンドシェイクで知り、仮定しません。
- 処理中の作業には、不変のスナップショットとして資格情報を渡します。
- サーバーは、保存している有効期限を強制し続けます。
