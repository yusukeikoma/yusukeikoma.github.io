---
title: "応答が失われても二重送信しない冪等な送信とバックオフ"
date: 2026-10-02T16:30:00+09:00
draft: true
tags: ["typescript", "idempotency", "reliability", "mobile"]
summary: "送信がタイムアウトしたとき、リクエストが失われたのか、確認応答だけが失われたのかは分かりません。クライアントが生成する nonce、nonce による到達確認の読み取り、持続的な不在の後の1回だけのリプレイ、確認の読み取りのバックオフを組み合わせると、信頼できるキューがなくても実質1回の配送に近づけます。"
math: false
isCJKLanguage: true
---

# 応答が失われても二重送信しない冪等な送信とバックオフ

スマートフォンが、リレーを介して別のマシン上のプロセスにメッセージを送ります。リクエストはモバイル回線を通り、少なくとも2ホップを経由し、応答も同じ道を戻ります。送信がタイムアウトしました。どうしますか。

正直な答えは、クライアントには分からない、です。リクエストが届かなかったのかもしれませんし、届いたけれど確認応答が失われたのかもしれません。送信側から見ると、この2つは見分けがつきません。しかも必要な対応は正反対です。前者には再送が必要で、後者には再送してはいけません。

## 素朴な選択肢のトレードオフ

| 方針 | 失敗のしかた |
|---|---|
| 再試行しない | リクエストが失われると、メッセージが失われます。ユーザーが打ち直します。 |
| 盲目的に再試行する | 確認応答が失われると、重複になります。ユーザーの指示が2回実行されます。 |
| エラーを出してユーザーに任せる | ユーザーにも分からないので、結局「もう一度送る」を選びがちです。 |

欲しいのは*実質1回*です。少なくとも1回の配送と、同じリクエストが繰り返されたら同じリクエストとして扱う受信側の組み合わせです。標準的な道具は冪等キーです（共通の形は [`Idempotency-Key` ヘッダーに関する IETF のドラフト](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)にあり、広く使われている例は [Stripe のドキュメント](https://docs.stripe.com/api/idempotent_requests)です）。面白いのはキーそのものではありません。クライアントがその*周り*で何をするかです。

## 仕組み: nonce と、問い合わせの手段

材料は2つです。

1. **ユーザーの意図ごとに1回だけ生成する nonce。** 最初の送信の前に生成し、保留中のメッセージと一緒に保存します。リプレイはすべてバイト単位で同一で、同じ nonce を運びます。受信側は、それで重複を排除します。
2. **nonce で読み取るエンドポイント。** クライアントは、ペイロードを再び送らなくても「この nonce の操作はどうなったか」を尋ねられます。

この2つがあれば、曖昧な送信が、システムが答えられる質問に変わります。「再送すべきか」ではなく、「届いたか」を尋ねるのです。リプレイは最初の反射ではなく、最後の手段です。

意図を作ってから答えを得るまでの間にアプリが落とされうるなら、nonce とペイロードは永続化しなければなりません（アウトボックス）。メモリにだけあった nonce はプロセスと一緒に消え、尋ねる手段も消えます。

## 判断の手順

```ts
export class CallError extends Error {
  constructor(public status: number, public code: string) {
    super(`${status} ${code}`);
  }
}
```

```ts
/** A definite answer from the server: stop, do not poll, do not replay. */
const refused = (e: unknown) => e instanceof CallError && e.status >= 400 && e.status < 500 && e.status !== 404;

export async function deliver<O extends Operation>(o: Options<O>): Promise<O> {
  const neverLandedMs = o.neverLandedMs ?? 10_000;
  const deadline = o.now() + (o.timeoutMs ?? 30_000);
  let wait = o.pollMs ?? 150;
  const waitMax = o.pollMaxMs ?? 1_000;

  let op: O | undefined;
  try {
    op = await o.start();
  } catch (e) {
    if (refused(e)) throw e; // ambiguity only: a lost ack looks like a timeout, not a 4xx
  }

  let absentSince: number | null = null;
  let replayed = false;
  while ((!op || op.state === 'preparing') && o.now() < deadline) {
    await o.sleep(wait);
    wait = Math.min(wait * 1.5, waitMax); // each read costs a billed round trip
    try {
      op = await o.fetch();
      absentSince = null;
    } catch (e) {
      const absent = e instanceof CallError && e.status === 404 && e.code === 'not_found';
      if (!absent) {
        absentSince = null; // unreachable proves nothing about whether it arrived
        continue;
      }
      absentSince ??= o.now();
      if (o.now() - absentSince < neverLandedMs) continue;
      if (replayed) throw new Error('never received'); // second absence: give up
      replayed = true;
      absentSince = null;
      try {
        op = await o.start(); // replay exactly once, same nonce
      } catch (re) {
        if (refused(re)) throw re;
      }
    }
  }
  if (!op) throw new Error('acceptance still unknown');
  if (op.state === 'failed') throw new Error('failed to start');
  // A queued receipt is durable delivery. Waiting for execution would report
  // every message held behind a running turn as lost.
  if (op.state === 'preparing') throw new Error('not confirmed in time');
  return op;
}
```

`deliver` のループには6つのルールが入っています。どれも、もっと単純な版には失敗があるために存在します。

**1. 明確な拒否は、すべてを止めます。** 到達できたサーバーからの 4xx は答えです。曖昧さが生じるのは答えが得られないとき、つまりタイムアウト、切断、5xx のときだけです。拒否を曖昧さとして扱うと、クライアントは存在しないものを待ってポーリングし、また拒否されるリクエストをリプレイします。唯一の例外は、*読み取り*に対する 404 で、次に述べます。

**2. 曖昧さは、再送ではなく読み取りで解決します。** 不明確な `start` の後で最初にするのは、nonce による `fetch` です。操作が「preparing」より先のどの状態でも存在すれば、確認応答が失われただけで、ほかに何もする必要はありません。「lost ack」のテストは、リクエストがちょうど1回だけ送られたことを確かめます。

**3. リプレイの前に、到達できるサーバーからの持続的な不在が必要です。** 最初の読み取りでの「not found」が証明することは少なく、元のリクエストがまだ経路のどこかにいて、もうすぐ着くかもしれません。いまリプレイすると、2つのコピーが競合し、受信側が nonce で重複を排除していても、リプレイが後続のメッセージを追い越して順序が変わることがあります。そのためループは、`not_found` が一定の窓のあいだ*連続して*返ることを求めます（窓はパラメータで、サンプルでは10秒、説明用の値です）。読み取りのそれ以外の結果は、すべて不在タイマーをリセットします。サーバーに届かなかった読み取りは、元のリクエストが届いたかどうかについて何も教えてくれないからです。

```ts
test('unreachable reads never count as absence', async () => {
  const c = clock();
  let reads = 0;
  let starts = 0;
  await assert.rejects(
    deliver({
      ...c,
      timeoutMs: 60_000,
      start: async () => {
        starts++;
        throw new Error('timeout');
      },
      fetch: async () => {
        reads++;
        throw new Error('socket down');
      },
    }),
    /acceptance still unknown/,
  );
  assert.equal(starts, 1);
  assert.ok(reads > 10);
});
```

窓は実際のトレードオフです。長くすれば、本当に失われたメッセージに気づくのが遅れます。短くすれば、遅い元のリクエストと競合する可能性が上がります。サーバー側にも対になる条件があります。受信側の重複排除の記録は、クライアントの再試行の全期間（タイムアウトとリプレイの窓）より長く生きなければなりません。そうでないと、リプレイが新しいものとして扱われます。

**4. リプレイは1回だけ。** 窓が過ぎたら、同じリクエストをもう一度送ります。次の窓のあいだの読み取りでも何も見つからなければ、失敗にします。永遠にリプレイするループは、持続的な障害をリクエストの嵐に変えます。ユーザーにとっては、対処できるエラーのほうが役に立ちます。

```ts
test('absent twice: fail instead of replaying forever', async () => {
  const c = clock();
  let starts = 0;
  await assert.rejects(
    deliver({
      ...c,
      timeoutMs: 120_000,
      start: async () => {
        starts++;
        throw new Error('timeout');
      },
      fetch: async () => {
        throw new CallError(404, 'not_found');
      },
    }),
    /never received/,
  );
  assert.equal(starts, 2);
});
```

**5. 成功とは、実行ではなく受理です。** 受信側は前のターンで忙しく、新しいメッセージをキューに入れるかもしれません。`queued` の受領は、耐久性のある配送です。システムが責任を引き受けたことを意味します。実行を待つようにすると、長時間かかるジョブの後ろで待たされているメッセージが、すべて失われたと報告されます。待つ終端状態は、ユーザーに何を約束したかから決めてください。

**6. デッドラインがすべてを抑えます。** 全体のタイムアウトがループを制限します。終了時点でも受理が不明なら、メッセージが失われたと断言せずに、不明であるとエラーに書きます。

## 型付きで、早めに拒否する

拒否のルールは、拒否が*型付き*であって初めて機能します。元のコードでは、これが目立たないバグでした。ペイロードがサイズ上限を超えたとき、失敗は型のない普通のエラーとして現れました。配送ループはそれをネットワークのタイムアウトと区別できず、曖昧さのときと同じことをしました。ポーリングし、不在の窓を待ち、リプレイし、最後には、決して成功しないリクエストに対して誤解を招くトランスポートエラーを報告したのです。

対処は、発生源で分類することです。確認できることは送る前にローカルで確認し、ループが「明確」と認識する型付きのエラーを投げます。

```ts
import { CallError } from './deliver.ts';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Refuse locally what the far side cannot or will not take. These are
 * definite answers, so they are typed errors: the delivery loop must stop on
 * them instead of treating them as "unknown, go and check".
 */
export function precheck(
  body: string,
  limits: { maxBytes: number },
  required: readonly string[],
  advertised: ReadonlySet<string>,
): void {
  if (bytes(body) > limits.maxBytes) throw new CallError(413, 'too_large');
  const missing = required.filter(f => !advertised.has(f));
  // An older host would ignore a field it does not know and "succeed" without
  // doing what the user asked. Say no before sending.
  if (missing.length > 0) throw new CallError(422, 'unsupported_feature');
}
```

細かい点が2つあります。サイズは文字数ではなくバイトで測ります。上限が適用されるのは、ワイヤに乗るものだからです（テストでは、マルチバイト文字列でそれを確かめています）。そして、必要な能力を、リモート側が宣言した能力と照合します。知らないフィールドを持つ古い受信側は、通常それを無視するので、メッセージは「成功」したのに、依頼された処理は黙って行われません。静かな劣化より、拒否のほうがましです。

```ts
test('a typed refusal from start() ends the loop with no reads', async () => {
  let reads = 0;
  let t = 0;
  await assert.rejects(
    deliver({
      now: () => t,
      sleep: async ms => void (t += ms),
      start: async () => {
        precheck('x'.repeat(20), { maxBytes: 10 }, [], caps);
        return { state: 'queued' as const };
      },
      fetch: async () => {
        reads++;
        return { state: 'queued' as const };
      },
    }),
    /413/,
  );
  assert.equal(reads, 0);
});
```

## 確認の読み取りのバックオフ

確認の読み取りは無料ではありません。従量課金のリレーでは1回ごとに課金対象のメッセージで、スマートフォンでは1回ごとに無線が起きます。短い固定の間隔は、数百ミリ秒で答えが来る一般的なケースには理想的ですが、元のリクエストが失われたと分かるまで何秒も待つ末尾のケースには無駄です。

そこでループは、上限までの間隔を等比的に伸ばします。サンプルは150ミリ秒から始め、1.5倍にして、1秒で頭打ちにします。これらは説明用の値です。20秒待つ場合の計算を示します。これはサンプル内の関数から出したもので、実システムの測定ではありません。

```ts
test('backoff: wait grows geometrically to a cap and cuts the number of reads', () => {
  const fixed = Math.floor(20_000 / 150); // fixed 150 ms for a 20 s wait
  const grown = schedule(150, 1.5, 1_000, 20_000);
  assert.deepEqual(grown.slice(0, 4), [150, 225, 337.5, 506.25]);
  assert.equal(Math.max(...grown), 1_000);
  assert.ok(grown.length < fixed / 3, `${grown.length} vs ${fixed}`);
  console.log(`# reads over a 20 s wait: fixed 150 ms = ${fixed}, backoff = ${grown.length}`);
});
```

150ミリ秒固定なら読み取りは133回、このスケジュールなら23回です。代わりに、結果に気づくのが、上限の長さ分まで遅れることがあります。成功やエラーの表示は、その間隔分だけ遅れうるということです。これがトレードオフで、上限を小さくしている理由です。上限を長くすると、読み取りはもっと減りますが、UI は重く感じられます。

## 使わないほうがよい場合

- **操作が冪等でなく、受信側が重複を排除しない。** nonce を尊重するサーバーがなければ、リプレイは重複になります。リプレイせず、ユーザーに尋ねてください。
- **エンドポイント間にすでに耐久性のあるキューがある。** トランスポート自身が確認応答と再配送を提供するなら、確認の層をもう1つ足すのは冗長な複雑さです。
- **重複は無害だが、エラーは無害ではない。** 値の設定や既読にする操作のように、もともと冪等なものがあります。単純な再試行で十分で、そのほうが簡単です。
- **読み取りの経路が書き込みの経路と同じくらい信頼できない。** サーバーに到達して読み取れないなら何も分からず、ループはデッドラインまで走ります。それが許されるのは、デッドラインがユーザーに答えを返せるほど短い場合だけです。

## 検証したことと、していないこと

ループ、ガード、スケジュールは、注入したクロックとスクリプト化したサーバーの挙動によるユニットテストで確かめています。確認応答の喪失、届いていない、2回続けての不在、到達できない読み取り、拒否、queued の各ケースを含みます。バックオフの効果を本番で測ってはいません。上の数字は、スケジュールに対する算術です。

## まとめ

- タイムアウトは曖昧です。意図ごとに nonce を生成して永続化し、リプレイはすべて同一にします。
- 曖昧さは、再送ではなく nonce による読み取りで解決します。
- リプレイは、到達できたサーバーからの持続的な不在の後に、1回だけ行い、それでもだめなら失敗にします。
- 拒否は型付きにして、送る前にバイト単位でローカルに確認します。拒否が曖昧さに見えてはいけません。
- 受理（`queued`）を配送として数え、読み取りの間隔は小さな上限まで伸ばします。
