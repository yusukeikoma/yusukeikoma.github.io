---
title: "ping なしの生存確認と、アイドル時のスリープ"
date: 2026-10-02T16:45:00+09:00
draft: true
tags: ["typescript", "go", "websocket", "heartbeat"]
summary: "一定間隔の keepalive は、接続が忙しいときでも双方向に1メッセージずつ使います。受信したフレームをすべて生存の証拠として扱い、静かな接続だけを確認し、既存のハートビートで待機中のホストに切断してよいかを伝えれば、その大半を減らせます。代償は、上限のある復帰の遅延です。"
math: false
isCJKLanguage: true
---

# ping なしの生存確認と、アイドル時のスリープ

keepalive は、通信が従量課金でクライアントがスマートフォンになるまで、解決済みの問題に見えます。そこには2つのコストが隠れています。1つ目は、一定間隔の ping が、すでにトラフィックを運んでいて生存を証明する必要のない接続でも、双方向に1メッセージずつ送ることです。2つ目は、誰も見ていない接続でも、念のため相手側のプロセスが接続を開き続けるので、ping を延々と送り続けることです。

この記事では両側を扱います。クライアントがソケットを死んだと判断する方法と、常駐するホストがそもそもソケットを必要としないと判断する方法です。

## クライアントの keepalive は何のためか

相手が FIN を送らずに消えた TCP 接続（ネットワークを切り替えたスマートフォン、マッピングを捨てた NAT、スリープしたノートPC）は、書き込みが失敗するかタイマーが発火するまで、アプリケーションからは開いたままに見えます。クライアントには自前のタイマーが必要です。要件は次の2つです。

1. 死んだ相手を、上限のある時間内に検知する。
2. 接続が健全な間は、できるだけ安く済ませる。

ブラウザや React Native が提供する [`WebSocket`](https://developer.mozilla.org/ja/docs/Web/API/WebSocket) には、プロトコルレベルの ping を送る API がありません。[RFC 6455 §5.5.2](https://www.rfc-editor.org/rfc/rfc6455#section-5.5.2) は Ping 制御フレームを定義していて、相手のスタックが自動で応答しますが、スクリプトからは送れません。したがって、スクリプトレベルの生存確認は、相手が応答しなければならない*アプリケーション*メッセージになります。それは実在するメッセージです。受信メッセージが課金されるリレー（[Durable Objects の料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)）では、課金対象です。

（Durable Object を自分で制御できるなら、[`setWebSocketAutoResponse`](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) で、ハイバネートから起こさずに固定の文字列へ応答させられます。これで応答のコストは下がります。問い合わせ自体が無料になるわけではなく、相手が Durable Object でないなら何の助けにもなりません。）

## すべてのフレームが生存の証拠

設計の原則は、ping が証明するのは「バイトがまだ届いている」ことだけ、ということです。データフレームも pong と同様にそれを証明します。そこで次のようにします。

- どんな種類でも、フレームを受信したら、静止タイマーをリセットし、未解決の確認を解除する。
- 確認を送るのは、接続が少なくとも間隔の分だけ静かだったときだけ。
- 確認のデッドラインは、*送った*時点から測る。以降の tick で延ばさない。

ポリシー全体は、タイムスタンプの純粋関数です。そのため fake timer なしでテストできます。

```ts
export type Action = 'wait' | 'ping' | 'close';

/**
 * Called from a fixed-interval tick. Any application frame counts as proof of
 * life, so only a quiet connection is probed, and a probe's deadline is fixed
 * at the moment it was sent.
 */
export function heartbeatAction(
  lastReceivedAt: number,
  pendingPingAt: number | null,
  now: number,
  intervalMs: number,
  timeoutMs: number,
): Action {
  if (pendingPingAt !== null) {
    // A second probe never extends the first one's deadline.
    return now - pendingPingAt >= timeoutMs ? 'close' : 'wait';
  }
  return now - lastReceivedAt >= intervalMs ? 'ping' : 'wait';
}
```

数秒おきに何かが届くストリームは確認されないので、忙しい接続は何も支払いません。そのテストは、あえて地味にしてあります。間隔より速くフレームを流し、ping が1つも送られなかったことを確かめます。

### tick の算術

チェックは一定間隔の tick で動き、そこから、あまり書かれない帰結が出てきます。間隔が10秒、タイムアウトが25秒だとします（説明用の値で、推奨値ではありません）。tick の1ミリ秒後にフレームが届きます。次の tick では、静止時間が9.999秒で、間隔未満なので答えは `wait` です。その次の tick では19.999秒になり、答えは `ping` です。25秒のデッドラインはそこから始まります。

最後のフレームから `close` の判断までの最悪ケースは、したがって*間隔2つ分とタイムアウト*です。この値なら45秒です。もっと短くしたいなら、間隔より細かく tick を回してください。確認を送るタイミングを決めるのは、tick の頻度ではなく静止のしきい値です。テストでは、20秒に送った確認がちょうど45秒で close になり、44.999秒では close にならないことを固定しています。

```ts
test('tick granularity: traffic just after a tick delays the ping, not the deadline', () => {
  const received = 1;
  assert.equal(act(received, null, 10_000, I, T), 'wait'); // only 9.999 s quiet
  assert.equal(act(received, null, 20_000, I, T), 'ping'); // next tick pings
  const pingAt = 20_000;
  for (const now of [30_000, 40_000, 44_999]) assert.equal(act(received, pingAt, now, I, T), 'wait');
  assert.equal(act(received, pingAt, 45_000, I, T), 'close'); // exactly timeout after send
});
```

`>=` の比較も決定の1つです。厳密な `>` にすると、時計が粗い刻みで進む環境で、理由なく1 tick 遅れることがあります。

### 遅れて届いた pong も pong

状態を持つラッパーでは、受信したすべてのフレームが `onFrame` を呼び、保留中の確認を解除します。デッドラインの後、次の tick より前に届いた pong も、普通のデータフレームも、どちらも接続を救います。確認が保留中の間に次の tick が来ても、2つ目は送らず、デッドラインも動かしません。

```ts
export class Heartbeat {
  private lastReceivedAt: number;
  private pendingPingAt: number | null = null;
  constructor(
    private now: () => number,
    private intervalMs: number,
    private timeoutMs: number,
  ) {
    this.lastReceivedAt = now();
  }
  /** Every parsed frame from the peer, not only pongs. */
  onFrame() {
    this.lastReceivedAt = this.now();
    this.pendingPingAt = null;
  }
  /** Run on a setInterval(intervalMs). */
  tick(send: () => void): Action {
    const now = this.now();
    const action = heartbeatAction(this.lastReceivedAt, this.pendingPingAt, now, this.intervalMs, this.timeoutMs);
    if (action === 'ping') {
      this.pendingPingAt = now;
      send();
    }
    return action;
  }
}
```

実際のコードでは、2点を調整してください。`now` には壁時計ではなく単調増加するクロック（`performance.now()`）を使い、時刻の調整でタイムアウトが偽装されないようにします。また、モバイルのライフサイクルを考えます。アプリが suspend されている間は JavaScript のタイマーが動かないので、復帰後の最初の tick が、ずっと前に送った確認を見つけることがあります。このポリシーでは、その場合ソケットをすぐに閉じます。これは正しい結果です。suspend をまたいだ接続は、生きているより死んでいる可能性が高く、再接続の経路はすでにあります。

## アイドル時のスリープ: 誰にも必要とされない接続

もう半分は、ユーザーのマシン上で動くエージェントのような、常駐するホストプロセスです。クライアントが到達できるように、リレーへのアウトバウンドの WebSocket を持ち続けます。1日の大半は誰も見ていません。それでも接続は存在し、keepalive が必要で、リレーのリソースを占有します。

目標は、誰かが必要としている間だけ接続を保持することです。仕組みには3つの要件があります。

**すでにある信号を使う。** ホストは、生きていることを伝えるために、コントロールプレーンを一定間隔で呼んでいます。その返信に、接続がいま必要かどうかのフィールドを1つ足します。そうすればスリープのためにポーリングも新しいエンドポイントも増えず、同じ呼び出しがホストを起こします。答えが元に戻るだけだからです。

**3値の答え。** 「不要」と「不明」を区別できなければなりません。Go ではポインタにします。

```go
// HeartbeatReply is what the control plane answers on the heartbeat that
// already exists. Needed is a pointer so an older server that does not send
// the field is distinguishable from one that says "no".
type HeartbeatReply struct {
	Needed *bool
}
```

このフィールドが導入される前のサーバーは、フィールドを返さないので `Needed` が nil になり、ホストは従来どおり接続を保ちます。ハートビートの失敗も、誰もホストを必要としていない証拠ではないので、やはり接続を保ちます。切断するのは、明示的に「不要」と言われたときだけです。

```go
// Run keeps a connection only while the control plane says someone needs it.
// The heartbeat doubles as the wake-up call, so sleeping costs no extra traffic.
func Run(ctx context.Context, d Deps) {
	var cur *session
	defer func() {
		if cur != nil {
			cur.stop()
		}
	}()
	ticker := time.NewTicker(d.Every)
	defer ticker.Stop()
	for {
		reply, err := d.Heartbeat(ctx)
		// Unknown stays connected: an old server never sent the field, and a
		// failed heartbeat is not evidence that nobody needs us.
		needed := err != nil || reply.Needed == nil || *reply.Needed
		switch {
		case needed && (cur == nil || !cur.running()):
			if cur != nil {
				cur.stop()
			}
			cur = start(ctx, d.Serve)
		case !needed && cur != nil:
			cur.stop()
			cur = nil
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
```

セッションのコンテキストをキャンセルし、goroutine の終了を待つので（`stop` は `done` でブロックします）、スリープ中のホストには接続用の goroutine が残りません。接続がまだ必要なのに切れた場合は、次のハートビートで再開します。

```go
func TestOlderServerWithoutTheFieldKeepsTheConnection(t *testing.T) {
	starts, stops := runScript(t, []HeartbeatReply{{}, {}, {}}, nil, 3)
	if starts != 1 || stops != 1 {
		t.Fatalf("starts=%d stops=%d", starts, stops)
	}
}
```

**正直なコストモデル。** スリープは、遅延とトラフィックを交換します。スリープ中のホスト宛てに届いた仕事は、次のハートビートで答えが切り替わり、ホストが再接続するまで待たされます。遅延は最大でハートビート1回分に接続確立の時間を足したものです。スリープ中のホストに対して再試行する処理は、それより長い再試行の猶予が必要です。そうでないと、静かな期間の後の最初のリクエストが、少し待てば成功したのに失敗します。実際の変更でも、まさにこの理由で再試行の猶予を延ばす必要がありました。

サンプルにはヒステリシスがありません。「必要」がハートビートごとに反転すると、ハートビートごとに接続と切断を繰り返し、つなぎっぱなしより悪くなります。復帰後に最低限の起動時間を設けるのが、よくある対処です。

## 使わないほうがよい場合

- **両端がプロトコルレベルの ping/pong を話せる。** サーバー同士や Durable Object 同士なら、トランスポート自身の ping を使ってください。安く、アプリケーションコードも要りません。この設計は、ブラウザのスクリプトからは送れないために存在します。
- **短命な接続。** ソケットが数秒しか生きないなら、節約できるものがありません。
- **最初のバイトの遅延が要件。** スリープは、アイドル後の最初のリクエストに、最大でハートビート1回分の遅延を足します。許容できないなら、つないだままにして、コストを受け入れてください。
- **相乗りできる既存のハートビートがない。** スリープを実現するためだけにポーリングを足すと、節約分を使い切ります。

## 検証したことと、していないこと

ハートビートのポリシーとスリープのループは、注入したクロックとスクリプト化した返信を使ったユニットテストで確かめています。長時間アイドルのままにした実際の接続のテストはなく、このしくみでトラフィックがどれだけ減るかも測っていません。ここでの主張は構造上のものです。忙しい接続は確認を送らず、コントロールプレーンが不要と言ったホストは接続を持ちません。

## まとめ

- スクリプトからプロトコルの ping は送れないので、生存確認はアプリケーションのメッセージになります。頻度を下げます。
- 受信したフレームをすべて生存の証拠とし、確認は静かな期間の後にだけ送り、デッドラインは送った時点から測ります。
- 間隔と同じ周期で tick すると、検知の最悪値は間隔2つ分とタイムアウトです。縮めたいなら tick を速くします。
- 既存のハートビートに「接続が必要か」を載せ、不明とエラーは「つないだまま」とします。
- スリープの代償は、上限のある復帰の遅延です。再試行の猶予をそれに合わせて確保します。
