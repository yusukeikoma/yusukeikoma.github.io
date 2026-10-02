---
title: "従量課金のリレーでのバッチ送信とフレーム上限"
date: 2026-10-02T16:50:00+09:00
draft: true
tags: ["go", "javascript", "websocket", "durable-objects"]
summary: "WebSocket のメッセージごとに課金され、フレームにも上限がある環境では、独立したフラッシュ条件を持つバッチ送信、上限より低い単一フレームのしきい値、上限付きの分割、混在バージョンのロールアウトを生き延びる能力フラグが必要です。難所は、終了時の順序と、ワイヤ上から消えるゼロ値です。"
math: false
isCJKLanguage: true
---

# 従量課金のリレーでのバッチ送信とフレーム上限

ユーザーのマシン上の Go プロセスが、リレーを介してブラウザやスマートフォンにイベントを流します。リレーは Cloudflare Durable Objects 上の JavaScript の Worker で、マシンとの間に1本のコントロール用 WebSocket を持ち、クライアントへフレームを転送します。ここを通るものには2つの制約があります。

1. **メッセージは従量課金です。** Durable Objects では WebSocket の受信メッセージが課金対象になり（リクエスト数に対して[20:1 の比率](https://developers.cloudflare.com/durable-objects/platform/pricing/)が適用されます）、送信メッセージは課金されません。イベントごとに1フレームを送る送信側は、イベントごとに支払います。
2. **フレームには上限があります。** 接続の両端は最大フレームサイズに合意しています。それより大きな応答は分割しなければならず、分割には上限が必要です。ないと、不正な相手のせいで再構成側のメモリ確保が際限なく増えます。

さらに3つ目があります。Worker、マシン側のプロセス、ブラウザのクライアントは、それぞれ別にデプロイされます。どの瞬間にも、どれかは古いバージョンです。新しいフレーム形式は、前提にするのではなく、ネゴシエーションしなければなりません。

この記事では4つの仕組みと、本当の教訓になった3つのバグを順に見ます。

## 1. 独立した3つのフラッシュ条件でイベントをバッチにする

小さなイベント（トークンの差分、状態変化）の流れは、メッセージ単位の課金にとって最悪のケースです。送信側はイベントをためておき、1フレームにまとめて送れます。引き換えに遅延が増えるので、窓で上限を決めます。

次の3つのうちどれか1つで、フラッシュします。

- **時間:** 空のバッチに最初のイベントが入ったときに窓が開き、短い固定の遅延の後に閉じます。これが遅延の上限です。
- **件数:** 1フレームあたりの最大イベント数です。受信側が検証すべき量の上限にもなります。
- **バイト数:** フレーム上限よりずっと小さいバイト予算です。*次の*イベントで予算を超えるなら、先にフラッシュして、そのイベントから新しいバッチを始めます。

```go
// Frame is one message on the shared control socket.
type Frame struct {
	Type     string  `json:"type"`
	StreamID string  `json:"stream_id"`
	Event    string  `json:"event,omitempty"` // single-event form (older peers)
	Data     string  `json:"data,omitempty"`
	Events   []Event `json:"events,omitempty"` // batched form, 2+ events
}
```

動作が決まるのは転送ループです。窓、件数、バイト数の上限は呼び出し側が渡す設定から来ます。適切な値は、フレーム上限と許容できる遅延によって変わります。

```go
// Forward batches events from in until it closes or ctx ends. Whatever was
// accepted is flushed before returning, on every exit path.
func Forward(ctx context.Context, cfg Config, streamID string, in <-chan Event, write WriteFunc) (err error) {
	var batch []Event
	size := 0
	timer := time.NewTimer(cfg.Window)
	timer.Stop()
	defer timer.Stop()

	flush := func(wctx context.Context) error {
		if len(batch) == 0 {
			return nil
		}
		f := Frame{Type: "stream_data", StreamID: streamID}
		if len(batch) == 1 { // a batch of one stays wire-compatible with old peers
			f.Event, f.Data = batch[0].Name, batch[0].Data
		} else {
			f.Events = batch
		}
		batch, size = nil, 0
		timer.Stop()
		return write(wctx, f)
	}

	// The terminal frame must follow every accepted event, even when ctx has
	// been cancelled. A write on a cancelled context would also tear down the
	// shared socket, so use a detached context with its own deadline.
	defer func() {
		wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		err = errors.Join(err, flush(wctx))
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if err := flush(context.WithoutCancel(ctx)); err != nil {
				return err
			}
		case ev, ok := <-in:
			if !ok {
				return nil
			}
			n := len(ev.Name) + len(ev.Data)
			if size+n > cfg.MaxBytes { // would overflow: ship what we have first
				if err := flush(context.WithoutCancel(ctx)); err != nil {
					return err
				}
			}
			if len(batch) == 0 {
				timer.Reset(cfg.Window) // the window opens with the first event
			}
			batch = append(batch, ev)
			size += n
			if size >= cfg.MaxBytes || len(batch) >= cfg.MaxEvents {
				if err := flush(context.WithoutCancel(ctx)); err != nil {
					return err
				}
			}
		}
	}
}
```

このループには、間違えやすい点が3つあります。

**1件のバッチは、バッチにせずに送ります。** ちょうど1件のフレームは、従来の単一イベントの形式を使います。バッチというものを知らない相手でも読めるので、静かなストリームではバッチ化が見えません。新しい形式が現れるのは、節約できるときだけです。

**窓は ticker ではなく、最初のイベントで開きます。** 常時動く ticker だと、tick の直後に届いたイベントに窓1つ分の遅延が丸ごとのってしまいますし、何も起きていないときにも goroutine が起きます。バッチが空から非空になったときにだけリセットするタイマーなら、アイドル中のコストはゼロです。

**終端フレームは、受理したすべてのイベントの後に来なければなりません。** ストリームが終わるとき（ソースが閉じた、資格情報が切れた、クライアントがキャンセルした）、受信側が最後に見るのは、すでに受理したバッチ、その次に終端マーカーであるべきです。defer したフラッシュはすべての終了経路で動きます。そこでは `context.WithoutCancel` と専用の短いデッドラインを使います。この切り離したコンテキストは飾りではありません。ここで使っている WebSocket ライブラリでは、キャンセル済みのコンテキストで書き込みを行うと接続が閉じられ、しかもこの接続はすべてのストリームで共有されています。キャンセル済みのコンテキストでフラッシュすると、バッチが落ちるうえ、ほかのストリームまで巻き込まれます。回帰テストは、2件が保留されている状態でキャンセルし、両方が1フレームで届いたこと、そして `write` に渡されたコンテキストがキャンセルされていなかったことを確かめます。

```go
func TestCancelFlushesAcceptedEventsOnADetachedContext(t *testing.T) {
	s := &sink{}
	in := make(chan Event)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Forward(ctx, Config{Window: time.Hour, MaxEvents: 100, MaxBytes: 1 << 20}, "s1", in, s.write)
	}()
	in <- Event{Data: "a"}
	in <- Event{Data: "b"}
	cancel()
	err := <-done
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if len(s.frames) != 1 || len(s.frames[0].Events) != 2 {
		t.Fatalf("accepted events were dropped: %+v", s.frames)
	}
	if s.errs[0] != nil {
		t.Fatalf("flush ran on a cancelled context: %v", s.errs[0])
	}
}
```

## 2. 収まるものは分割しない

小さなチャンクサイズを超えるものをすべて分割する設計は、最初に思いつく案ですが、無駄が多くなります。チャンクはそれぞれ課金対象のメッセージですし、数百キロバイト程度の中くらいのペイロードはよくあります。よりよいルールは、リレー自身のメタデータ用の予約を引いた上限に収まるなら、1フレームで送り、それを超える場合だけ分割することです。

```go
// ShouldChunk keeps medium payloads in one frame: only fragment what cannot
// fit under the hard cap once the relay's own metadata is reserved.
func ShouldChunk(payload, hardCap, reserve int, peerChunks bool) (bool, error) {
	if payload <= hardCap-reserve || !peerChunks {
		if payload > hardCap {
			return false, errors.New("frame too large and peer cannot reassemble")
		}
		return false, nil
	}
	return true, nil
}
```

最後の分岐は、混在バージョンで重要です。再構成できない相手には、ハード上限に収まるなら単一フレームを送り、収まらないならエラーにします。黙って捨てられる断片は送りません。

## 3. 送信側だけでなく、再構成側にも上限をかける

分割はリスクを受信側に移します。受信側は、チャンクを敵対的な入力として扱わなければなりません。接続ごとに課す上限は、1メッセージあたりのチャンク数、0から始まる厳密な増加順、再構成後の合計バイト数、そして最初のチャンクから測ったデッドラインです。

```go
func Split(id string, payload []byte, size int) []Chunk {
	count := (len(payload) + size - 1) / size
	out := make([]Chunk, 0, count)
	for i := 0; i < count; i++ {
		end := min((i+1)*size, len(payload))
		out = append(out, Chunk{ID: id, Index: i, Count: count, Data: payload[i*size : end]})
	}
	return out
}
```

```go
// Assembler enforces bounds per connection: chunk count, strict order,
// reassembled bytes, and a deadline from the first chunk.
type Assembler struct {
	MaxChunks, MaxBytes int
	Deadline            time.Duration
	Now                 func() time.Time

	id      string
	next    int
	buf     []byte
	started time.Time
}
```

テストのケースは、上限があることの意味そのものを突きます。インデックス0から始まらなければならない、欠番を拒否する、デッドラインを過ぎたら拒否する、バイトの上限を超えたら拒否する、の4つです。

## 4. 能力をネゴシエーションし、リプレイをまたいで持ち運ぶ

新しいフレーム形式は、受信側がそれを理解すると宣言したときにだけ使います。受信側は購読リクエストで `accept_batches`（分割の場合は `accept_chunks`）を立てます。このフィールドを知らない送信側は無視して、単一イベントのフレームを送り続けます。難しいのは中間のリレーです。[Durable Objects はハイバネートする](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)ので、メモリ上の状態には頼れません。そのため、購読をソケットに紐づけて永続化し、マシン側が再接続したときにそれを再生します。保存された購読が受信側のフラグを忘れていると、再生のたびにストリームが黙ってバッチなしに劣化します。何も壊れないので誰も気づきませんが、請求書が来るまで、コストの悪化は見えません。

```js
// Worker side (JavaScript on Durable Objects): the peer's capabilities are
// stored with the subscription, so a replay after hibernation or a reconnect
// asks the producer for exactly what the consumer can read.
export function rememberSubscription(attachment, value, limit = 16) {
  const subscriptions = (attachment.subscriptions || []).filter(s => s.requestID !== value.request_id);
  if (subscriptions.length < limit) {
    subscriptions.push({
      requestID: value.request_id,
      path: value.path,
      acceptChunks: value.accept_chunks === true,
      acceptBatches: value.accept_batches === true,
    });
  }
  return { ...attachment, subscriptions };
}

export function replayFrames(attachment, connectionID) {
  return (attachment.subscriptions || []).map(s => ({
    type: 'subscribe',
    connection_id: connectionID,
    request_id: s.requestID,
    path: s.path,
    accept_chunks: s.acceptChunks === true,
    accept_batches: s.acceptBatches === true,
  }));
}
```

再生される subscribe メッセージにフラグが入っているので、送信側は受信側が読める形式を保ったまま再開します。アタッチメントにも上限があります。小さく保ち、購読の数にも上限を置きます。受信側は、受け取ったものを信用する前に検証します。

```ts
const MAX_EVENTS = 32;

/** Normalise single and batched frames into an ordered list of events. */
export function streamFrames(message: StreamMessage) {
  const { events } = message;
  if (
    events !== undefined &&
    (!Array.isArray(events) ||
      events.length < 1 ||
      events.length > MAX_EVENTS ||
      events.some(e => !e || typeof e.data !== 'string' || (e.event !== undefined && typeof e.event !== 'string')))
  ) {
    throw new Error('invalid stream batch'); // caller closes the socket
  }
  const list: Array<{ event?: string; data?: string }> = events ?? [message];
  // The terminal flag rides on the frame, so it applies after the last event only.
  return list.map((e, i) => {
    const last = i === list.length - 1;
    return {
      event: e.event,
      data: e.data,
      closed: last && (message.closed ?? false),
      error: last ? (message.error ?? null) : null,
    };
  });
}
```

不正なバッチは、一部だけ適用せず、ソケットを閉じます。終端フラグとエラーは、フレームの最後のイベントにだけ適用します。これで、1. で述べた順序の保証が受信側でも保たれます。（このサンプルの初期版では、フラグをバッチのすべてのイベントに付けていました。型検査は通りましたが、このために書いたテストで間違いに気づきました。）

```ts
test('the terminal flag applies after the last event of a batch only', () => {
  const out = streamFrames({ events: [{ data: 'a' }, { data: 'b' }], closed: true });
  assert.deepEqual(out.map(e => e.closed), [false, true]);
});
```

この方式なら、ロールアウトの順序は関係ありません。経路上のどこかがフラグより古いなら、フラグは届かず、送信側はバッチを使わず、受信側のノーマライザは単一イベントのフレームを1件のバッチとして扱います。

## 3つのバグ

**消えたゼロ。** チャンクには `chunk_index` が付きます。最初の版では、Go の構造体でこれに `omitempty` を付けていました。`int` では `omitempty` はゼロを落とします（[`encoding/json`](https://pkg.go.dev/encoding/json#Marshal)）。そのため、分割されたすべてのメッセージの最初のチャンクが、インデックスなしで送られました。ブラウザは再構成できず、大きなペイロードはずっと読み込み中のままでした。小さなペイロードでは起きないので、バグは生き延びました。直し方は、インデックスとカウントに `omitempty` を付けない専用のワイヤ用構造体にすることと、生の JSON をデコードしてキーが存在することを確かめるテストです。同じ構造体を通して往復するテストでは、欠落を検出できません。サンプルのテストでは、素朴な構造体でバグを再現してから、修正を確かめます。

```go
func TestChunkIndexZeroIsOnTheWire(t *testing.T) {
	if wireHasIndex(naiveChunk{ID: "x", Index: 0, Count: 2}) {
		t.Fatal("expected omitempty to drop index 0 (this is the bug)")
	}
	if !wireHasIndex(Chunk{ID: "x", Index: 0, Count: 2}) {
		t.Fatal("explicit tag must keep index 0")
	}
}
```

**制御チャネルに載る巨大なペイロード。** チャンク化すると、巨大な diff もリレー経由で送れてしまいます。そこから得る教訓として、それは間違いです。レビュー画面のよりよい直し方は、ペイロードを送らないことでした。変更されたファイルをメタデータだけで一覧にし、ファイル1件の本文は必要になったときに取得し、diff を作る子プロセスの出力は、全部バッファしてからではなく、読み取りながら上限をかけます（上限に達したら kill して回収します）。チャネルの容量は、使ってよいという許可ではありません。

**古いホスト。** 分割に対応する前のホストは、大きすぎる読み取りに `response_too_large` のエラーで答えます。履歴をページングする呼び出し側は、より小さいページで再試行します。この互換経路は昔からあり、意図的に不格好なままです。新しい経路を厳格にできるのは、この経路があるからです。

## 使わないほうがよい場合

- **遅延に厳しい単一イベントのストリーム。** バッチ化は最大で窓1つ分の遅延を足します。入力のエコーでは、退行になります。
- **コストより、ストリームをまたいだ順序のほうが重要。** バッチが保つのは、1つのストリームの中の順序です。ストリームをまたいで特定の順に並べる必要があるものは、別の設計が必要です。
- **すべての相手が一斉にアップグレードされる。** 送信側、リレー、受信側を1つの単位としてデプロイするなら、ネゴシエーションは省けます。ネゴシエーションはロールアウトのためにあり、フラグはどれもテストすべき対象が増えるということです。
- **課金が問題ではない。** バッチ化と分割は複雑さです。メッセージが無料のトランスポートに足してはいけません。

## 検証したことと、していないこと

サンプルは `go test -race`（繰り返し実行）で動かし、TypeScript と JavaScript の部分は `node:test` で動かしています。本番の変更には独自のユニットテストがあり、終端フレームの順序についての回帰テストも含まれます。そのテストは修正前には失敗していました。実際のプラットフォーム上での挙動は検証していませんし、バッチ化でメッセージがどれだけ減るかも測っていません。言えるのは構造上のことだけです。以前はイベントごとに課金対象のメッセージを1件送っていた送信側が、いまは窓、件数、バイト予算のいずれかにつき最大1件を送ります。バッチが足す遅延は、最大でも窓1つ分です。

## まとめ

- バッチは独立した3つの条件（時間、件数、バイト数）で行い、超過するイベントの前にフラッシュします。
- 単一イベントはバッチにせず、上限から予約分を引いた値に収まるなら単一フレームを保ちます。
- 受理したイベントは、すべての終了経路で、切り離した上限付きのコンテキストを使って終端フレームの前にフラッシュします。
- 再構成側に上限を置きます。件数、順序、バイト数、デッドラインです。
- リプレイをまたいで残るフラグでネゴシエーションし、ロールアウトの順序に依存しないようにします。
- ゼロ値は明示的にシリアライズし、ワイヤ上の JSON をテストします。
