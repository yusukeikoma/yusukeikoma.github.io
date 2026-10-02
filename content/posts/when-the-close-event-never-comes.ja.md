---
title: "close イベントが来ないとき"
date: 2026-10-02T16:35:00+09:00
draft: true
tags: ["websocket", "react-native", "typescript", "debugging"]
summary: "自分のソケットの close イベントを待ってから後始末するクライアントは、そのイベントが届かないと、黙って止まることがあります。接続を終えると決めた時点で状態を確定させ、後始末を冪等にし、イベントは自分が始めていない切断のために残します。"
math: false
isCJKLanguage: true
---

# close イベントが来ないとき

症状は説明しやすく、原因は見つけにくいものでした。接続の相手側で資格情報が更新された後、モバイルクライアントが返信を受け取らなくなります。エラーも、ログも、クラッシュもありません。画面を開き直すと直ります。こういう回避策は、バグを長いあいだ隠します。

原因は、クライアントのライフサイクルにあった1つの前提でした。*自分で閉じたときでも、ソケットは閉じたことを教えてくれる、という前提です。*

## 失敗の流れ

クライアントは WebSocket を1本持ち、その上で複数の論理ストリームを多重化していました。後始末は1か所、ソケットの `close` イベントハンドラにありました。

1. アクティブなすべてのストリームに終了（`closed`）を伝え、持ち主が再購読できるようにする。
2. 返信を待っていたすべてのリクエストを reject する。
3. 接続オブジェクトを解放する。

相手側が資格情報をローテーションしてストリームを終えると、クライアントは設計どおり自分のソケットを閉じ、後始末が動くように `close` を待ちました。問題になった React Native のケースでは、アプリケーション自身が閉じたソケットがこのイベントを届けませんでした。そのため手順1が実行されず、ストリームの持ち主には伝わらず、再購読も起きず、返信は行き場を失いました。状態は正常に見えます。接続オブジェクトは存在し、ストリームは登録されたままで、何も届かなくなっただけです。

確かに言えることを、慎重に整理します。仕様に沿った実装では、`close` イベントは接続が閉じたときに発火します。自分から閉じた場合は、クロージングハンドシェイクが完了するか、接続が破棄された後です（[WHATWG の WebSocket 仕様](https://websockets.spec.whatwg.org/#feedback-from-the-protocol)、[MDN の `close` イベント](https://developer.mozilla.org/ja/docs/Web/API/WebSocket/close_event)）。これは「即座」ではありませんし、相手が消えていれば長くかかることがあります。問題の実行環境については、観測された挙動と、それをモデル化したテストに頼っていて、文書化された保証に基づいているわけではありません。それでも、設計上の結論はどちらの場合でも成り立ちます。

## 原則: イベントは報告し、決定は確定させる

イベントハンドラは、自分に*起きた*ことを知る場所としては正しい場所です。相手が閉じた、ネットワークが落ちた、プロトコルエラーが起きた。一方で、*自分が*下した決定を記録する場所としては適切ではありません。決定は、下した瞬間に状態を更新すべきです。「閉じてください」とお願いして、それが起きたという通知を待つ設計は、自分の制御フローを、自分で制御できないコールバックが届くかどうかに依存させます。

変更は小さなものです。

- 後始末を `settle` という1つの関数に移します。何度呼んでも安全で、実際の処理は1回しか行いません。
- 自分が始めていない切断のために、イベントハンドラからそれを呼びます。
- *自分で*接続を終えると決めたときに必ず使う唯一のメソッド `end()` から、ソケットに close を依頼した直後に呼びます。

```ts
export interface SocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type StreamFrame = { closed: true; error: string } | { data: string };

export class Connection {
  readonly pending = new Map<string, { reject(e: Error): void }>();
  readonly streams = new Map<string, (f: StreamFrame) => void>();
  private settled = false;

  constructor(
    private socket: SocketLike,
    private onListenerError: (e: unknown) => void = e => console.error(e),
  ) {
    // Still the path for closes we did not start: peer, network, server.
    socket.addEventListener('close', this.settle);
    socket.addEventListener('error', this.settle);
  }

  /** Idempotent: every path may call it, only the first does anything. */
  private settle = () => {
    if (this.settled) return;
    this.settled = true;
    // Take the work out of the tables first, then notify. A listener that
    // throws must not stop the others from hearing about it.
    const pending = [...this.pending.values()];
    const streams = [...this.streams.values()];
    this.pending.clear();
    this.streams.clear();
    for (const p of pending) this.guard(() => p.reject(new Error('connection closed')));
    for (const onFrame of streams) this.guard(() => onFrame({ closed: true, error: 'connection closed' }));
  };

  private guard(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.onListenerError(e);
    }
  }

  /**
   * Close the socket ourselves AND settle what rode it, now. The socket's
   * close event is a notification we may or may not get; it is not the
   * source of truth for what we just decided to do.
   */
  end(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } finally {
      this.settle();
    }
  }
}
```

正しさを支えているのは、次の3点です。

**`settle` は冪等です。** イベントを届けるランタイムでは、`end()` の後でイベントがやはり届くことがあります。2回目の呼び出しは何もしてはいけません。そうでないと、すべてのストリームの持ち主が2回通知され、2回再購読するかもしれません。`FakeSocket(true)` を使うテストは、イベントを遅れて届けて、通知がちょうど1回であることを確かめます。

**「後」ではなく `finally`。** `close()` は例外を投げることがあります（仕様上、不正なコードや長すぎる理由に対して投げますし、ラッパーが独自の理由で投げることもあります）。投げる呼び出しの後ろに後始末を並べると、デバッグしているまさにその経路で後始末が飛ばされます。`try { close } finally { settle }` なら後始末は無条件に実行され、例外は呼び出し元に伝わります。

**通知する前に、テーブルから取り出す。** リスナーは任意のコードを実行します。持ち主は `closed` に反応して、新しい接続を始めたり、何かを登録したりするかもしれません。`settle` が生きているマップを反復していたら、それに触るリスナーは、中途半端に後始末された状態を見ることになります。先にエントリを取り出してテーブルをクリアすれば、リスナーが見るのは、空になって終わった接続です。リスナーはそれぞれ自分の `try/catch` の中で実行します。そうしないと、例外を投げる1つのバグったリスナーが、その後ろに登録されたすべてのリスナーにとって同じ「黙って止まる」状態になります。これも、形を変えた同じバグです。

## 直す前に再現する

テスト用のダブルは、`close` を絶対に発火しないように設定できるソケットです。最初のテストは、元のバグを実行可能な記述として残したものです。

```ts
class FakeSocket implements SocketLike {
  readyState = 1;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(private emitsCloseEvent: boolean) {}
  addEventListener(type: 'close' | 'error', l: () => void) {
    (this.listeners[type] ??= []).push(l);
  }
  close() {
    this.readyState = 3;
    if (this.emitsCloseEvent) queueMicrotask(() => this.listeners['close']?.forEach(l => l()));
  }
  fire(type: 'close' | 'error') {
    this.listeners[type]?.forEach(l => l());
  }
}
```

```ts
test('relying on the event alone loses the frame (the original bug, reproduced)', async () => {
  const sock = new FakeSocket(false);
  const conn = new Connection(sock);
  const frames = subscribe(conn);
  sock.close(); // what the old code did: close and wait for the event
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(frames, []); // nobody was told; nothing resubscribes
});
```

このテストは、あえて間違った挙動を表明しています。ソケットを直接閉じて待つと、ストリームにはフレームが1つも届きません。その隣には、修正がなければ失敗し、修正があれば通るテストがあります。

```ts
test('a self-initiated close settles streams even if the socket never fires close', () => {
  const conn = new Connection(new FakeSocket(false));
  const frames = subscribe(conn);
  conn.end(1000, 'renew');
  assert.deepEqual(frames, [{ closed: true, error: 'connection closed' }]);
});
```

修正は「`end()` を足す」だけではありません。接続を終えるすべてのコード経路が `end()` を通ることが修正です。更新、期限切れ、アイドルタイムアウト、ハートビートのタイムアウト、認証のタイムアウト、拒否、不正なフレームです。どこか1か所でも迂回すると、その原因に対してこの停止が戻ってきます。生の `socket.close()` をクラスの外から呼べないようにしておくと、将来の変更がこれを飛ばせなくなります。

## この種のバグが生き延びる理由

黙って止まる障害は、普段のシグナルでは捕まりません。例外は出ず、タイムアウトも起きず、エラーを見張る監視には、静かで健全な接続に見えます。状態機械には、設計上は close の後に*到達できない*はずなのに、実際には到達できてしまう状態（「接続済みで、ストリームが登録されている」）があり、その不変条件を確かめるものがありませんでした。2つの習慣が役に立ちます。

- 不変条件を書き出します。*接続が終わったら、その上に登録されたすべてのリクエストとストリームに、ちょうど1回、通知される。* そして、前提を1つずつ破るソケットのダブルで、その不変条件をテストします。close イベントがない、遅れる、重複する、close なしの error、`close()` が例外を投げる、の5つです。
- 通知が失われうる場所で、「持ち主が通知を待つ」設計は臭いと考えます。終わったことを伝えられない持ち主は、永遠に待ちます。通知を確実にできないなら、待つ側にデッドラインを与えてください。

## 使わないほうがよい場合

- **原因によって後始末が変わる。** ユーザー起点の close とネットワーク障害で扱いを変える必要がある場合（たとえば障害のときだけ再接続する）は、`settle` に理由を渡し、最初の原因を優先します。遅れて届いた `error` イベントで、意図した close を上書きしてはいけません。
- **クロージングハンドシェイクの完了を待つ必要がある。** 相手が close を確認した後でしか行えない処理、たとえば相手が close を見るまで保持している資源の解放があるなら、やはりイベントが必要です。早めに確定させるのは、自分側の帳簿のためであり、相手が知っていることの証明ではありません。
- **新しい接続が古い接続の状態を再利用する。** 置き換えの接続をすぐに作り、古い接続と可変のマップを共有していると、古いソケットから遅れて届いたイベントが新しい状態を壊します。サンプルのように状態を接続オブジェクトごとに持つか、もう現在のものではないソケットからのイベントは無視してください。

## 検証したことと、していないこと

挙動は、上のソケットのダブルに対して検証しています。回帰テストは、イベントだけに頼る版では失敗し、`end()` を使う版では通ります。修正後に実機で長時間のソークは行っていません。したがって、実機で数分間の更新がすべてきれいになったとは主張せず、言えるのは、後始末が、届いていなかったイベントに依存しなくなったということだけです。

## まとめ

- イベントは、自分で下した決定の根拠としては弱い情報源です。決めた時点で状態を確定させます。
- 冪等な `settle` を、`end()` とイベントハンドラの両方から呼べば、遅れたイベント、重複したイベント、来ないイベントのすべてを扱えます。
- `close()` が例外を投げても後始末が動くよう `try/finally` を使い、通知の前に状態を切り離して、リスナーが中途半端な接続を見ないようにします。
- 接続を終えるすべてのコード経路を `end()` に通します。
- 前提を1つずつ破るダブルで不変条件をテストし、元の失敗はテストとして残します。
