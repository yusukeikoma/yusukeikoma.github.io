---
title: "大きなストリーム履歴の再開: 畳み込みキャッシュとバイト予算"
date: 2026-10-02T16:25:00+09:00
draft: true
tags: ["typescript", "react-native", "caching", "streaming"]
summary: "小さなイベントのジャーナルとして保存された会話は、開き直すのに高くつきます。ジャーナルを純粋関数で最終的な項目へ畳み込み、畳み込んだ状態をバイト予算付きのメモリ上の LRU に置き、全件を再生する代わりに、連番カーソルとページサイズのバックオフで再開します。"
math: false
isCJKLanguage: true
---

# 大きなストリーム履歴の再開: 畳み込みキャッシュとバイト予算

長く続くセッションは、ジャーナルとして保存されます。小さなイベントを追記していくだけの列で、各イベントには連番が付きます。モデルの返信は何百ものテキストの差分として届き、その後に、それらを置き換える最終的な項目が来ます。画面を描くには、ジャーナルを再生して、ユーザーに見える項目の一覧に畳み込みます。

初めて画面を開くときは、そうするしかありません。2回目以降は、そうすべきではありません。この記事は、開き直しの話です。すぐに何かを見せ、新しい分だけを取得し、最適化をメモリの問題に変えないことです。

## トレードオフ

ジャーナル全体を読み直して開き直すスマートフォンは、3回支払います。バイトを転送し（メッセージ単位で課金し、フレームサイズに上限があるかもしれないリレーを通ります）、何千ものイベントを畳み込むために CPU を使い、そのあいだユーザーは空白の画面を見ています。候補になる対策は次のとおりです。

| 選択肢 | 何が問題か |
|---|---|
| ジャーナルをディスクに保存する | 保存時の機密、履歴が書き換えられたときの無効化、容量の増加、イベント形式を変えるたびのマイグレーション。 |
| 畳み込んだ結果をディスクに保存する | プライバシーと鮮度の懸念は同じで、フットプリントは小さい。 |
| 畳み込んだ結果をメモリに置く | アプリを終了すると消え、OS が許す量に制限されるが、保存時の露出がなく、マイグレーションするスキーマもない。 |
| サーバーにスナップショットを頼む | サーバーを制御できるなら最良。そうでなければ選べない。 |

ここでの設計は3つ目です。弱点（メモリ）に対処するのが予算で、強みは何もディスクに書かないことです。会話の内容に対しては、まずこれを検討します。

## ステップ1: 純粋関数とカーソルで畳み込む

畳み込みは、直前の状態とエンベロープのバッチの純粋関数でなければなりません。そうすれば、キャッシュの中でも、ストリームのハンドラでも、テストでも、同じ結果で動かせます。重要な性質は3つです。

**カーソル。** 結果には、最後に畳み込んだエンベロープ `lastSeq` を記録します。再開とは「これより厳密に後のすべて」を意味します。

**重複に対する冪等性。** キャッチアップの読み取りとライブのストリームは重なります。最後のページがまだ届いている間に、カーソルから購読するからです。カーソル以下のエンベロープはスキップするので、同じ末尾を2回畳み込んでも何も起きません。テストはまさにこれを確かめます。`fold(f, tail)` が `f` と深く等しくなることです。これは、連番が1つのジャーナルの中で厳密に増加することを前提にしています。イベントが順不同で届きうるなら、連番によるフィルタは有効なイベントを落とすので、もっと強い重複排除が必要です。

**リセットの合図。** サーバーが以前の履歴を書き換えた（圧縮や編集）とき、カーソルはもう再開できる位置ではありません。ジャーナルは `reset` エンベロープでそれを伝えます。畳み込みは項目を消してフラグを立て、キャッシュはリセットされた状態を保持しません。リセットより前に畳み込まれたものを、二度と表示してはいけません。

```ts
export type Envelope =
  | { seq: number; kind: 'text_delta'; id: string; text: string }
  | { seq: number; kind: 'item'; id: string; text: string }
  | { seq: number; kind: 'reset' };

export interface Folded {
  /** Cursor: the last envelope folded in. Resume reads strictly after it. */
  lastSeq: number;
  items: { id: string; text: string }[];
  /** The server said earlier history was rewritten: nothing here is reusable. */
  reset: boolean;
}

export const emptyFold: Folded = { lastSeq: 0, items: [], reset: false };

/** Pure: thousands of tiny deltas become a few final items. */
export function fold(prev: Folded, envelopes: Envelope[]): Folded {
  let { lastSeq, reset } = prev;
  const items = [...prev.items];
  const index = new Map(items.map((it, i) => [it.id, i]));
  for (const e of envelopes) {
    if (e.seq <= lastSeq) continue; // overlap between catch-up and stream
    lastSeq = e.seq;
    if (e.kind === 'reset') {
      items.length = 0;
      index.clear();
      reset = true;
      continue;
    }
    const at = index.get(e.id);
    if (at === undefined) {
      index.set(e.id, items.length);
      items.push({ id: e.id, text: e.text });
    } else if (e.kind === 'text_delta') {
      items[at] = { id: e.id, text: items[at]!.text + e.text };
    } else {
      items[at] = { id: e.id, text: e.text }; // the final item supersedes its deltas
    }
  }
  return { lastSeq, items, reset };
}
```

最終的な項目は、断片を（追記ではなく）置き換える（`items[at] = ...`）ので、畳み込んだ形はジャーナルのごく一部になります。サンプルの合成ジャーナル（50個の差分を持つ項目が5つ）では、生の JSON が15123文字で、畳み込んだ項目は1111文字でした。これは私のテストデータであり、畳み込みが断片をまとめることを示すだけです。実際のセッションの測定ではありません。

## ステップ2: 件数ではなく、バイトで上限を決めたキャッシュ

セッションのサイズは、桁違いに異なります。「N 件まで」の LRU は、巨大なセッションがいくつかあるだけで、想定したメモリ量を簡単に超えます。かといって N を小さくすると、小さなセッションに対して無駄が出ます。予算はバイトで決めます。

```ts
import type { Folded } from './fold.ts';

/**
 * In-memory only: gone when the app quits, never written to disk or to a
 * persisted query cache. Keyed by account scope + session to avoid crossing
 * accounts.
 */
export class FoldCache {
  private entries = new Map<string, { fold: Folded; bytes: number }>();
  private total = 0;

  constructor(private maxBytes: number) {}

  key(scope: string, sessionId: string): string {
    return `${scope}:${sessionId}`;
  }

  get(key: string): Folded | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key); // Map keeps insertion order: delete + set = "most recent"
    this.entries.set(key, e);
    return e.fold;
  }

  set(key: string, fold: Folded): void {
    this.forget(key);
    if (fold.reset || fold.items.length === 0) return; // nothing worth resuming from
    const bytes = JSON.stringify(fold.items).length * 2; // UTF-16: an honest estimate
    if (bytes > this.maxBytes) return; // one entry may not evict everything else
    this.entries.set(key, { fold, bytes });
    this.total += bytes;
    for (const [oldest, e] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest); // first key = least recently used
      this.total -= e.bytes;
    }
  }

  forget(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.total -= e.bytes;
  }

  get size() {
    return this.total;
  }
}
```

このキャッシュには、間違えやすい選択がいくつかあります。

- **`Map` を LRU として使う。** `Map` は挿入順に反復されます。読み取りでキーを削除して再挿入するので、先頭のキーが常に最も長く使われていないものになり、追い出しは「予算に収まるまで先頭から消す」になります。連結リストは要りません。
- **サイズは安く見積もり、その見積もりが粗いことを認める。** `JSON.stringify(items).length * 2` は UTF-16 のテキストの近似です。オブジェクトのオーバーヘッドやエンジン固有の事情は無視しているので、桁の見当にはなりますが、メモリを厳密に勘定するには足りません。予算は保守的に設定し、保持する内容の上限として扱ってください。
- **サイズ超過のエントリは保存せず、何も追い出さない。** 代替案は、保存して、場所を空けるためにほかをすべて追い出すことです。それだと、巨大なセッション1つが、他のすべてのキャッシュを流してしまいます。テストは、サイズ超過の `set` の後でキャッシュサイズが変わらないことを確かめます。
- **リセットされた畳み込みと空の畳み込みは保持しない。** リセットされた畳み込みには、安全に再開できる位置がありません。空の畳み込みからは、何も再開できません。`set` は先に `forget` を呼ぶので、リセットは古いエントリを削除することで置き換えます。古い畳み込みがキーの下に残ると、次に開いたときに表示されてしまいます。
- **キーにアカウントのスコープを含める。** セッション ID は、アカウントの中でしか一意ではありません。セッションだけをキーにしたキャッシュは、アカウントを切り替えた後に、前のアカウントの内容を次のアカウントに見せるおそれがあります。テストは、同じセッション ID でもスコープが違えば分離されることを確かめます。サインアウト時にはキャッシュも消してください。
- **メモリのみ。** リレー経由で取得したセッションの内容は、永続化されるクエリキャッシュから意図的に除外します。すべてのクエリ結果をディスクにシリアライズする便利なライブラリのデフォルトを使うと、そうしないかぎりディスクに書き出されてしまいます。

## ステップ3: カーソルから再開する

開き直す手順は次のとおりです。

1. キャッシュを読む。畳み込みがあれば、すぐに描画する。
2. キャッチアップする。`lastSeq` より厳密に後のジャーナルを、ページ単位で要求し、畳み込んでいく。
3. ライブのストリームを、「いま」からではなく*カーソルから*購読する。

ステップ3は、最後のキャッチアップのページと購読が有効になる時点との隙間を埋めます。サーバーはカーソルより後のものを再生し、`fold` の連番フィルタが重複を取り除きます。「いま」から購読すると、その間に届いたものを失います。

キャッチアップにはもう1つ落とし穴があります。ページがチャネルに対して大きすぎることがあるのです。リレーのフレーム上限や、分割できない古いホストです。読み取り側は、ページサイズを半分にして、*同じ*カーソルで再試行します。カーソルは決して後ろに戻らず、要求より短いページが返ったらループを終えます。

```ts
import { fold, type Envelope, type Folded } from './fold.ts';

export class TooLarge extends Error {}

/**
 * Catch up from the cursor, halving the page when a response is too big for the
 * channel, then hand the cursor to the live stream. Returns the folded state.
 */
export async function catchUp(
  start: Folded,
  readPage: (after: number, limit: number) => Promise<Envelope[]>,
  pageSize = 500,
): Promise<Folded> {
  let state = start;
  let limit = pageSize;
  for (;;) {
    const before = state.lastSeq;
    let page: Envelope[];
    try {
      page = await readPage(before, limit);
    } catch (e) {
      if (!(e instanceof TooLarge) || limit === 1) throw e;
      limit = Math.max(1, Math.floor(limit / 2)); // smaller pages, same cursor
      continue;
    }
    state = fold(state, page);
    if (page.length < limit || state.lastSeq === before) return state;
  }
}
```

2つのテストでこれを確かめています。1つ目は、2回目の開き直しがカーソルより後のものだけを読むことです。

```ts
test('resume reads only what came after the cursor', async () => {
  const j = journal(4, 5);
  const seen: Array<[number, number]> = [];
  const read = async (after: number, limit: number) => {
    seen.push([after, limit]);
    return j.filter(e => e.seq > after).slice(0, limit);
  };
  const first = await catchUp(emptyFold, read, 10);
  assert.equal(first.lastSeq, j.length);
  seen.length = 0;
  j.push({ seq: j.length + 1, kind: 'item', id: 'new', text: 'fresh' });
  const second = await catchUp(first, read, 10);
  assert.deepEqual(seen, [[first.lastSeq, 10]]);
  assert.equal(second.items.at(-1)?.id, 'new');
});
```

2つ目は、大きなページを拒否するチャネルの下で、カーソルが前に進み続けながらページサイズが 64、32、16、8 と下がることです。

```ts
test('page size halves on too-large responses and the cursor never moves backwards', async () => {
  const j = journal(3, 8);
  const limits: number[] = [];
  const read = async (after: number, limit: number) => {
    limits.push(limit);
    if (limit > 8) throw new TooLarge();
    return j.filter(e => e.seq > after).slice(0, limit);
  };
  const f = await catchUp(emptyFold, read, 64);
  assert.deepEqual(limits.slice(0, 4), [64, 32, 16, 8]);
  assert.equal(f.lastSeq, j.length);
  assert.equal(f.items.length, 3);
  await assert.rejects(catchUp(emptyFold, async () => { throw new TooLarge(); }, 4), TooLarge);
});
```

## 畳み込みをいつ書き戻すか

キャッシュへの書き込みは、差分のたびに行ってはいけません。コンポーネントは畳み込みを自分の状態として持ち、破棄されるとき（エフェクトのクリーンアップ）にキャッシュへ書き込みます。そうすれば、キャッシュには常に、ユーザーが実際に見た最後の状態が入ります。ライブのストリームでは、エンベロープごとではなく短い窓でまとめて畳み込みに反映します。何百もの差分からなる返信でも、描画は数回で済みます。接続自体はフォアグラウンドの関心事です。アプリがバックグラウンドに入ると閉じ、復帰したらカーソルから再開します。開き直しと同じ経路です。

キャッシュされた畳み込みは、あなたが見たものであって、真実ではありません。常にキャッチアップへの入力であり、キャッチアップの代わりにはなりません。

## 使わないほうがよい場合

- **履歴が小さい。** 全件の読み直しが数キロバイトなら、キャッシュとその無効化ルールのコストが、節約を上回ります。
- **オフラインでの閲覧が要件。** メモリ上の状態は再起動をまたぎません。接続なしで履歴を読めなければならないなら、暗号化した永続化と、それに伴う無効化の作業が必要です。
- **サーバーがスナップショットを返せる。** サーバー側の圧縮は、ワイヤ上のバイトも節約できるので、クライアント側の畳み込みに勝ります。
- **イベントが順不同で届く、または履歴がその場で編集される。** 単調なカーソル1つは、追記のみを前提にしています。それが成り立たないなら、再開できる位置が存在しません。

## 検証したことと、していないこと

畳み込み、キャッシュ、キャッチアップのループは、ユニットテストで確かめています。重複、リセット、追い出しの順序、サイズ超過、アカウントの分離、ページサイズの半減、カーソルの単調性です。端末で開き直しがどれだけ速くなるか、メッセージがどれだけ減るかは測っていないので、どちらも主張しません。上のサイズの数字は、テスト内の合成ジャーナルから出したものです。

## まとめ

- ジャーナルは、カーソルを持ち、見たものをスキップし、リセットを尊重する純粋関数で畳み込みます。
- 畳み込んだ状態をバイト予算付きでメモリにキャッシュします。リセット、空、サイズ超過の畳み込みは保存せず、キーにはアカウントのスコープを含めます。
- 開き直すときは、キャッシュを表示し、カーソルより後をページサイズのバックオフ付きでキャッチアップし、カーソルから購読します。
- 畳み込みは破棄時に書き戻し、キャッチアップへの入力として扱います。真実としては扱いません。
