---
title: "ポーリングを変更通知の購読に置き換え、ポーリングは保険として残す"
date: 2026-10-02T17:00:00+09:00
draft: true
tags: ["typescript", "websocket", "react-native", "realtime"]
summary: "メッセージ単位で課金されるリレー越しに、モバイルクライアントがタイマー駆動のポーリングから共有の変更通知へ移った経緯を扱います。難しいのはストリームそのものではなく、保険のポーリングをいつ止めてよいかを正直に決めることです。"
math: false
isCJKLanguage: true
---

# ポーリングを変更通知の購読に置き換え、ポーリングは保険として残す

モバイルクライアントが、リレーを介して遠隔マシン上の常駐プロセスと通信しています。リレーは Cloudflare Durable Objects 上の薄い Worker で、マシンとの WebSocket と各クライアントとの WebSocket を保持し、メッセージを転送するだけです。複数の画面が「何が変わったか」を知る必要があります。最初の実装はタイマーで答えていました。会話一覧を数秒ごとに読み直し、マシンがオンラインかどうかをコントロールプレーンに数秒おきに問い合わせ、作業ツリーの diff はタブを切り替えるたびに読み直します。

これは動きますし、最初の実装として正しい選択です。ただ、通信がメッセージ単位で課金されるようになると、正しいとは言えなくなります。

## コストモデルが強いること

Durable Objects では、WebSocket の受信メッセージが課金対象になり、送信メッセージは対象になりません（[料金ドキュメント](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。リレー越しのポーリングは、クライアントからのリクエストとマシンからのレスポンスの組なので、受信メッセージ2件に当たります。1画面で `T` 秒ごとにポーリングすると、1時間あたり `7200 / T` 件です。ユーザーが机の上に開いたまま置いているだけの画面でも、この数になります。受信メッセージのたびにオブジェクトのハンドラが動くため、ポーリングを続けるとオブジェクトがハイバネートできなくなります（[WebSocket のベストプラクティス](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)を参照）。

実機での削減量は測っていません。以下に出てくる数字は、実行されなくなった定期リクエストの数から出した計算であり、観測した割合ではありません。

自然な置き換えは変更通知の購読です。会話が変化したことはマシン側がすでに知っているので、問い合わせを待たずに `upsert` イベントを push できます。ただし、この置き換えが本当に改善になるかどうかは、次の3つのトレードオフで決まります。

- **「live」の正しさ。** ストリームが存在するだけでポーリングを止めると、ストリームが存在しても何も流れてこない状況で、遅延の問題が正しさの問題になります。
- **共有。** 5つのフックがそれぞれ自分のストリームを開くのは、5つのポーリングより悪くなります。
- **ストリームが何の証拠になるか。** ストリームは別のシグナル（ここではプレゼンス）の代わりになることがありますが、それは理由を説明できる場合に限ります。

## 仕組み: キーごとに1本の共有ストリームと、正直な `live` フラグ

キーごとにストリームを1本だけ持ち、参照カウントで共有します。ストリームはまずスナップショットを1回送り、その後は変更のたびに upsert を送ります。利用側は `{ live, items }` を受け取ります。保険のポーリングが参照してよいのは `live` だけです。

```ts
export interface Item {
  id: string;
  updatedAt: string;
}

export interface FeedState<T extends Item> {
  /** The stream has delivered data, so the fallback poll may stand down. */
  live: boolean;
  /** Last known list, newest first. null until the first snapshot. */
  items: T[] | null;
}

export interface Handlers<T extends Item> {
  snapshot(items: T[]): void;
  upsert(item: T): void;
  closed(): void;
}
/** Opens the stream; resolves to a function that stops it. */
export type Open<T extends Item> = (h: Handlers<T>) => Promise<() => void>;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const HEALTHY_MS = 30_000;
```

フィード本体は小さなステートマシンです。重要な点は `publish`、`connect`、`closed` ハンドラの3か所にあります。

```ts
class Feed<T extends Item> {
  state: FeedState<T> = { live: false, items: null };
  refs = 0;
  listeners = new Set<(s: FeedState<T>) => void>();
  private byId = new Map<string, T>();
  private stopStream: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private openedAt = 0;
  private disposed = false;

  constructor(private open: Open<T>) {
    this.connect();
  }

  private publish(live: boolean) {
    // The last known list outlives a drop: stale rows beat an empty pane,
    // and the fallback poll refreshes them while `live` is false.
    const items =
      this.byId.size === 0 && this.state.items === null
        ? null
        : [...this.byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.state = { live, items };
    for (const listener of this.listeners) listener(this.state);
  }

  private connect() {
    let ended = false;
    const drop = () => {
      if (ended || this.disposed) return;
      ended = true;
      this.stopStream = null;
      // A connection that stayed healthy earns a fresh backoff.
      if (this.openedAt && Date.now() - this.openedAt >= HEALTHY_MS) this.attempts = 0;
      this.openedAt = 0;
      this.publish(false);
      const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempts, RETRY_MAX_MS);
      this.attempts += 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, delay);
    };
    this.open({
      // `live` is published by the first frame, never by "the socket opened".
      snapshot: items => {
        if (ended || this.disposed) return;
        this.byId = new Map(items.map(i => [i.id, i]));
        this.publish(true);
      },
      upsert: item => {
        if (ended || this.disposed) return;
        this.byId.set(item.id, item);
        this.publish(true);
      },
      closed: drop,
    }).then(
      stop => {
        if (ended || this.disposed) return stop();
        this.stopStream = stop;
        this.openedAt = Date.now();
      },
      drop, // failing to open is a drop like any other
    );
  }

  dispose() {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopStream?.();
  }
}
```

**`live` は open ではなく最初のフレームから決めます。** `open()` が解決しても、購読が受理されたことしか分かりません。リレーが受理してもマシンが応答しないことはありますし、プロキシがバッファしていることもあります。open の時点で `live` を立てると、開いたのに何も届かないストリームが、保険のポーリングを永久に黙らせてしまいます。`live` をスナップショットから公開すれば、「live」は「データが届いた」という意味になります。保険のポーリングが知りたいのはこの性質だけです。

**最後に分かっていた一覧は、切断後も残します。** 空の画面より古い行のほうがましです。`live` が false の間は、保険のポーリングがそれを更新します。そのため、コードは `drop()` をまたいで `byId` を保持しています。

**バックオフは、接続が健全だったと確認できたときだけリセットします。** open に成功するたびに試行回数を戻すと、接続が不安定に切れ続ける場合に、最短の間隔で永久に再試行します。ここでは、直前の接続が `HEALTHY_MS` 以上続いたときにだけカウンタを戻します。

**open の失敗も切断として扱います。** Promise の reject 経路も同じ `drop` を呼びます。ストリームを開けない状況（トランスポートがまだない、バインディングがない）では、描画経路に例外を投げるのではなく、ポーリングに劣化させるべきです。

共有は参照カウント付きのレジストリで行います。最後の解放でストリームを止めます。

```ts
const feeds = new Map<string, Feed<any>>();

/** Share one stream per key; the last release stops it. */
export function acquire<T extends Item>(
  key: string,
  open: Open<T>,
  listener: (s: FeedState<T>) => void,
): () => void {
  let feed = feeds.get(key) as Feed<T> | undefined;
  if (!feed) {
    feed = new Feed(open);
    feeds.set(key, feed);
  }
  feed.refs += 1;
  feed.listeners.add(listener);
  listener(feed.state);
  const held = feed;
  return () => {
    held.listeners.delete(listener);
    if (--held.refs > 0) return;
    held.dispose();
    feeds.delete(key);
  };
}
```

アプリがバックグラウンドにある間は、すべての購読を停止します。[React Native の `AppState`](https://reactnative.dev/docs/appstate) に従う形です。iOS はバックグラウンドのアプリを suspend するので、ソケットを保持し続けることは期待できません。中途半端に死んだ接続より、復帰時にきれいに再接続するほうが安全です。

## 保険のポーリングは、ストリームの関数にする

ポーリングが動く理由は1つだけです。ストリームがデータを届けていないときです。それ以外ではすべて止めます。

```ts
const STEPS_MS = [5_000, 10_000, 20_000, 30_000];

/** Fallback poll cadence: widen while nothing changes, snap back on change. */
export class FallbackSchedule {
  private step = 0;
  next(changed: boolean): number {
    this.step = changed ? 0 : Math.min(this.step + 1, STEPS_MS.length - 1);
    return STEPS_MS[this.step]!;
  }
  reset() {
    this.step = 0;
  }
}

/** false = do not poll at all. */
export function pollInterval(o: {
  live: boolean;
  foreground: boolean;
  schedule: FallbackSchedule;
}): number | false {
  if (!o.foreground) return false; // nothing is on screen
  if (o.live) return false; // the stream is the source of truth
  return STEPS_MS[0]!; // caller widens it with schedule.next(changed)
}
```

このファイルには3つのルールがあります。非表示ならポーリングしません。live ならポーリングしません。live でないならポーリングし、変化がないあいだは間隔を広げます。間隔を広げる仕組みは、購読がそもそも使えない環境（古いホスト、制限されたネットワーク）で効きます。これがないと、購読できないクライアントは最速の周期で永久にポーリングし続けます。代償は、検知の遅れが最大の間隔までに伸びることです。

テストには fake timer を使いました（Node の `node:test` の `mock.timers` で、`Date` もモックされます）。残す価値があったケースは次のとおりです。スナップショットのない open は live ではない。切断すると一覧は残り、`live` が false になり、1秒後、2秒後に再試行する。健全なまま続いた接続は遅延をリセットする。2つの利用側が1本のストリームを共有し、最後の解放で止まる。

## ストリームが別のシグナルの代わりになるとき

クライアントは、マシンがオンラインか、現在のユーザーにまだ紐づいているかを知るために、コントロールプレーンへも定期的にポーリングしていました。ストリームは代替に見えます。マシンがオンラインで、権限が有効なときにしか流れないからです。しかし、このシステムではストリームが「オフラインになったこと」を通知することはできません。オンライン状態は「最終確認時刻」から計算していて、マシンが消えても何も書き込まれないため、push すべきイベントがないのです。

そこでルールをこうしました。ストリームが流れている間は、ストリーム自体がプレゼンスの証拠になるので、コントロールプレーンへのポーリングは止めます。ストリームが切れたら `live` が false になり、ポーリングが再開し、オフライン状態はこれまでどおり1ポーリング間隔以内に現れます。プレゼンスが変わったときにデータベースから通知を出す案も検討しましたが、削減できる量に対してマイグレーションとトリガーのリスクが見合わないため、見送りました。

## ポーリングがあったから隠れていたバグ

ポーリングをなくしたことで、その副作用への隠れた依存が見つかりました。トランスポートは、見たことのある会話を覚えておき、それを使って会話ごとの購読を始めます。一覧ストリームで届いた会話は覚えられていませんでした。ポーリングが動いている間は気づけず、ポーリングを止めると、新しく始まった会話はストリームで届くのに購読できなくなりました。直し方は、ストリームで届いた項目もトランスポートに記録することです。回帰テストでは、ストリーム経由でしか届かなかった項目をトランスポートに渡します。

これは一般的な危険です。冗長なポーリングは、状態機械のレビューされていない2つ目の実装でもあります。消すときは、それが偶然何を埋めていたかを grep してください。

## 通知で「古い」かどうかを決める

同じ考え方は、キャッシュした読み取りにも使えます。作業ツリーの diff 画面は、以前は表示するたびに、一定の鮮度期間を過ぎていれば再取得していました。いまは画面が見えている間、ホストのファイル変更通知を購読します。通知ストリームが生きている間は、キャッシュした diff を古いとは見なしません。生きていないときは、通常の時間ベースの鮮度判定に戻ります。

TanStack Query で書くと、`staleTime: live ? Infinity : undefined` に加えて、通知が来たときの invalidate です。画面を切り替えても再取得が走らなくなり、ユーザーが画面を見ている間に行った編集が反映されるようになりました。ポーリング版では反映されませんでした。

この変更でもう1つ。購読が拒否された場合は、アプリの前面復帰やネットワーク復旧のような「今すぐ再試行」の合図があっても、一定時間待ってから再試行します。こうした合図は一時的な失敗のためのものです。拒否は一時的ではないので、合図に従うと密なループになります。

## 使わないほうがよい場合

- **「ストリームが落ちている」と「何も起きていない」を区別できない。** スナップショットを先に送るプロトコルやハートビートがなければ、無音のストリームは静かなストリームと見分けがつかないので、ポーリングを残す必要があります。
- **イベントの発生源が、表示している内容をカバーしていない。** ここでプレゼンスが成り立ったのは、ストリームが何を意味するかという論証があったからです。そうした論証がないなら、そのシグナルはポーリングし続けてください。
- **再開用のカーソルがなく、イベントを取りこぼしうる。** 購読は、真のデータ源に対する最適化です。再接続時に真実を読み直せないなら、ポーリングをバグに置き換えただけです。この側面は、関連記事『リアルタイム通知による取り直しをまとめる: キーの絞り込みと先頭・末尾の窓』で扱います。
- **ポーリングがもともと安い。** メッセージ課金のないトランスポートなら、5行の interval のほうが、参照カウント付きの共有レジストリより優れています。

## 検証したことと、していないこと

上のユニットテストは通っています。ストリームが開いたのに何も届かない失敗ケースも含みます。端末でのメッセージ数やバッテリーは測っていません。ここで述べた削減は、なくなった定期リクエストの数から導いたものです。

## まとめ

- 購読がポーリングの代わりになるのは、`live` が「ソケットが開いた」ではなく「データが届いた」を意味するときだけです。
- キーごとに1本のストリームを参照カウントで共有し、切断後も最後の一覧を残し、バックオフは健全な接続を確認できたときだけリセットします。
- 保険のポーリングは、`live` と表示状態だけの関数にして、変化がないあいだは間隔を広げます。
- ストリームを別のシグナルの代わりにしてよいのは、理由を説明できるときだけです。検知の遅れが弱くなることは、受け入れたうえで書き残します。
- ポーリングを消すと、システムのほかの部分が頼っていた副作用も消えます。出荷前に探してください。
