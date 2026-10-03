---
title: "リアルタイム通知による取り直しをまとめる: キーの絞り込みと先頭・末尾の窓"
date: 2026-10-03T13:30:00
draft: false
tags: ["typescript", "react-native", "react-query", "realtime"]
summary: "リアルタイムイベントでクライアントのキャッシュを無効化すると、データの変化量よりはるかに多くの再取得が発生することがあります。一覧のキーだけに一致する述語と、キーごとの先頭・末尾の窓という2つの小さな修正と、結果を正しく保つためのルールを説明します。"
math: false
isCJKLanguage: true
---

# リアルタイム通知による取り直しをまとめる: キーの絞り込みと先頭・末尾の窓

WebSocket がモバイルクライアントに「タスクが変わった」と伝えます。クライアントの反応は1行です。そのワークスペースのキャッシュを無効化して、いま画面にあるデータをデータ層に再取得させます。これは正しく、コードは2行で済みます。そして、1回の変更を静かに数十回のリクエストに変えることがあります。

この記事では、その1行に潜む2つの乗数と、それぞれを抑える最小限の修正を扱います。コードは TanStack Query の [`invalidateQueries`](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation) の語彙を使っていますが、考え方はライブラリに依存しません。

## 2つの乗数

**キーの広がり。** クエリキーは階層になっています。一覧は `['tasks', ws, filter]`、タスクの詳細は `['tasks', ws, 'detail', id]` です。タスクのアクションや関連するプルリクエストなども、同じ `['tasks', ws]` の接頭辞の下にあります。接頭辞を無効化すると、いまマウントされているものがすべて再取得されます。そのため、タスク7の変更で、別のタブで開いているタスク12の詳細画面まで再取得されます。

**イベントのバースト。** エージェントの実行や一括編集は、イベントを1件では終えません。バーストになります。以前は、イベントごとに一覧の1ページ分を丸ごと再取得していました。

トレードオフは鮮度とリクエスト量の間にあり、その上に正しさの制約が乗ります。リクエストを減らすためにどんなことをしても、最後のイベントより古い状態を画面に出してはいけません。

## 修正1: 一覧は述語で、個別の項目は正確なキーで無効化する

一覧のキーと項目のキーは、3番目の要素が違います。一覧には3番目の要素がないか、あってもオブジェクト（フィルタ）です。それ以外はすべて項目レベルです。これだけで述語が書けます。

```ts
type Key = readonly unknown[];

/** Minimal slice of a query client (TanStack Query shaped). */
export interface Cache {
  invalidate(opts: { key: Key; predicate?: (key: Key) => boolean }): void;
}

/**
 * Keys share a prefix: ['tasks', ws] is a list; ['tasks', ws, 'detail', id]
 * is one item. A prefix invalidation hits both. A list key has either no third
 * segment or an object (the filter); everything else is item-level.
 */
export function isList(key: Key): boolean {
  const third = key[2];
  return third === undefined || (typeof third === 'object' && third !== null);
}

export const WINDOW_MS = 2_000;
```

ここから2つの選択が出てきます。id を持つ `task.changed` イベントは、述語で一覧を無効化し、そのタスクの詳細を正確なキーで無効化します。一括の並べ替えイベントには id がありません。1回の操作で多くの項目が動くからです。この場合は一覧だけを更新します。イベントは変わった範囲のうち最も狭いキーを名指しし、ハンドラはそれより広いキーに手を伸ばしません。

述語はキーの形に依存します。一覧と項目の両方のキーを述語に通すテストで、その形を固定してください。このテストは安く書けますし、想定外の3番目の要素を持つキー群が追加されたときに落ちてくれます。

## 修正2: キーごとの先頭・末尾の窓

絞り込みで、1回の再取得が触る範囲は減ります。しかし、バーストによる再取得の回数は減りません。そこで、先頭のエッジで発火し、その後はイベントが続く間、窓ごとに最大1回だけ発火する窓を使いました。

```ts
const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; again: boolean }>();

/** Leading edge now; at most one trailing refetch per window while events keep coming. */
export function refreshLists(cache: Cache, prefix: Key): void {
  const id = JSON.stringify(prefix);
  const open = windows.get(id);
  if (open) {
    open.again = true; // remember that something arrived inside the window
    return;
  }
  const run = () => cache.invalidate({ key: prefix, predicate: isList });
  run(); // leading: a lone event is reflected immediately
  const close = () => {
    const w = windows.get(id);
    if (!w?.again) {
      windows.delete(id); // quiet window: next event is a leading edge again
      return;
    }
    w.again = false;
    run(); // trailing
    w.timer = setTimeout(close, WINDOW_MS); // keep the window open while events continue
  };
  windows.set(id, { timer: setTimeout(close, WINDOW_MS), again: false });
}
```

イベントごとの動作は次のとおりです。

1. 最初のイベントですぐに更新し、窓を開きます。
2. 窓の中に届いたイベントは、フラグを立てるだけです。
3. フラグが立ったまま窓が終わったら、再取得を1回行って窓を再び張ります。フラグがなければ状態を削除します。
4. 静かな窓の後の次のイベントは、再び先頭のエッジです。

単発の変更はすぐに反映され、バーストの再取得は先頭と末尾の1回ずつで済み、長いバーストでもイベント数ではなく窓の数に比例する回数で済みます。先頭のエッジがあるので、これは単なる debounce ではありません。debounce では、単発の変更が静かになるまで待たされます。末尾のエッジがあるので、単なる throttle でもありません。先頭でしか発火しない throttle は、バーストの最後のイベントを落として画面を古いままにします。手順3の再武装は忘れやすい点です。これがないと、長いバーストの2回目以降の末尾の再取得が実行されません。

状態はキーごと（`JSON.stringify(prefix)`）に持つので、2つのワークスペースが窓を共有することはありません。

```ts
export function onTaskChanged(cache: Cache, workspace: number, taskId: number | null): void {
  refreshLists(cache, ['tasks', workspace]);
  if (taskId != null) cache.invalidate({ key: ['tasks', workspace, 'detail', taskId] });
}
```

項目ごとの無効化は窓の外に置いています。変わった1件に対する1リクエストだからです。

検証には fake timer を使いました。連続20件のイベントで先頭の再取得が1回、末尾の再取得が1回。その後イベントのない窓が来ても再取得は0回。窓が閉じた後のイベントは再び先頭のエッジです。単発のイベントでは、末尾の再取得は残りません。

テストを書いていて気づいた点が2つあります。モジュールレベルの窓の状態には、エクスポートしたリセット関数が必要です。なければ、あるテストで開いた窓が次のテストに漏れます。また fake timer を使う場合、タイマーを作った fake clock がまだ有効なうちにこの状態を消し、それから本物のタイマーに戻してください。最初は順序を間違え、漏れたタイマーのせいで次のテストが失敗し、ロジックのバグに見えました。

## 再接続したことは、同期できたことではない

イベントのバーストは簡単なほうのケースです。難しいのは、受け取っていないイベントです。このイベントストリームには連番も再開用のカーソルもないので、切断の後で何を取りこぼしたかをクライアントは知りようがありません。スマートフォンでは、これが頻繁に起きます。iOS はバックグラウンドのアプリを suspend し、ソケットも一緒に消えるからです。そこでクライアントはアプリの状態に追従し（バックグラウンドで切断、フォアグラウンドで接続）、接続に成功するたびに一覧を読み直します。

```ts
// No sequence numbers or resume cursor in the event stream: after any
// (re)connect the client cannot know what it missed, so it re-reads.
export function onConnected(cache: Cache, workspace: number): void {
  cache.invalidate({ key: ['tasks', workspace] });
}
```

私のルールはこうです。イベントストリームが取りこぼしを教えてくれないなら、真のデータ源は API であり、(再)接続は API をもう一度参照するタイミングです。イベントは、早めに再取得するためのヒントです。データそのものではありません。

## 無効化に購読者がいることを確かめる

ここまでの作業中に、地味ですが教訓になることを見つけました。リアルタイムの配線はすでにできていました。フォアグラウンドでソケットを開き、トークンを取得し、アプリ状態の変化で再接続し、イベントごとにキャッシュキーを無効化していました。ところが、アプリのどのクエリもまだそのキーを使っていませんでした。無効化はすべて、存在しないキャッシュエントリに対する何もしない処理でした。

ハンドラのユニットテストでは、これを見つけられません。テストが確かめるのは `invalidateQueries` が正しいキーで呼ばれることで、それは満たされていたからです。誰かが聞いていることまでは確かめられません。クライアントにリアルタイムを追加するときは、両端をつなぐアサーションを1つ入れてください。そのキーを使うクエリが登録されていること、あるいは、そのキーがクエリと同じファクトリから作られていることです。そうしないと、機能は動いてバッテリーと通信量を使うのに、何も更新しない状態になりえます。

## 使わないほうがよい場合

- **途中の状態がすべて必要。** 監査ビューやライブカーソルは、すべてのイベントを見る必要があります。まとめる処理は、ヒントの列に対する不可逆な圧縮です。
- **イベントがデータそのものを運んでいる。** イベントに新しい値が丸ごと入っているなら、`setQueryData` でキャッシュに反映し、再取得は省きます。再取得に窓をかけるのは、イベントがポインタにすぎないときだけ意味があります。
- **再取得が軽い。** ローカルキャッシュから出る小さな一覧には、窓は要りません。プロファイルでバーストが見えたときに足してください。先回りは不要です。
- **キーをまたいだ厳密な順序が重要。** 窓によって、一覧は項目レベルの更新より遅れます。両方を表示して一致させる必要がある画面では、まとめて更新するか、短い不一致を受け入れてください。

## 検証したことと、していないこと

fake timer を使ったユニットテストは、上で述べたとおり通っています。端末でイベント数や再取得数を数えてはいないので、実際にどれだけリクエストが減るかは主張しません。主張できるのは構造だけです。バースト中の一覧の再取得回数は、イベント数ではなく窓の数で抑えられます。

## まとめ

- 一覧と項目の両方を覆うキーの接頭辞は、1回の変更を多数の再取得に変えます。一覧は述語で、項目は正確なキーで無効化します。
- キーごとの先頭・末尾の窓は、単発の変更を即時に反映し、バーストを抑え、末尾のタイマーが再武装される限り、最後のイベントを落としません。
- 連番がないなら、再接続は読み直しを意味します。イベントはヒントとして扱います。
- 無効化に購読者がいることを確認するチェックを入れます。正しい関数を呼ぶハンドラでも、何にもつながっていないことがあります。
