# kasumilog

霞が関関連のTwitter投稿を、アカウントと発信主体を混同せずに扱うためのカタログと
private rawアーカイブ基盤です。現在はカタログ、分類モデル、リスト差分、Relayリクエスト生成、
完全raw保存、fixtureのGit往復検証、承認付きmanual収集workflowまでを実装しています。
実Twitter取得や書き込みはまだ行っていません。rawから毎回再生成するローカルSQLite/FTS検索POCもあります。

## モデル

```text
post metadata
  ├─ publisher ---------> account
  ├─ originalPublisher -> repost / quote source account (optional)
  └─ account subjects
       ├─ publisher  -> organization | person | role
       ├─ represents -> organization | person | role
       └─ personal   -> person
```

投稿メタデータには `publishedAt` と分類根拠の `classifiedBy` も保存します。ドメインは
次の4種類だけです。

- `administration`: 行政
- `politics`: 政治家・政党・選挙
- `legislature`: 国会
- `judiciary`: 裁判所

### 官邸と総理

`@kantei` の発行主体は常に `cabinet_secretariat` です。通常の官邸投稿は
`administration`、総理としての発信だと判定した投稿は `role: prime_minister` と
`publishedAt` から、その時点の人物を解決して `politics` として扱います。

人物と役職の関係は `RoleAssignment` に `[validFrom, validTo)` の期間で保存します。
第102〜105代の総理について登録済みで、総理交代後もアカウント・組織・過去投稿を
書き換える必要はありません。官邸が公表する在職開始日を日本時間の開始時刻として
記録しています。

### 分類根拠

- `account`: 発行主体で分類
- `role`: 投稿時点の役職者を解決して分類
- `manual`: 呼び出し側がドメインを明示

個人アカウントは、役職または明示ドメインなしでは自動分類しません。

## アカウントカタログ

`src/catalog.ts` に主要省庁・庁の28アカウントと、高市早苗氏の個人アカウントを
収録しています（計29アカウント）。各アカウントは
Twitter内部ID、`active` / `inactive` の状態、最終確認日 `verifiedAt` を持ちます。

2026-08-17にTwitter Relayの `UserByScreenName` で公式プロフィールと内部IDを照合し、
次の10機関を追加しました。

- 政府広報オンライン
- 気象庁
- 消防庁
- 海上保安庁
- 国税庁
- 出入国在留管理庁
- 特許庁
- 公正取引委員会
- 個人情報保護委員会
- 原子力規制委員会

実験用profile `account2`では、2026-08-18に非公開リスト`kasumilog`を作成し、
activeカタログ29件とのexact syncと完全一致検証まで行いました。timeline収集workflowは
まだ実行していません。

## リスト差分管理

`src/sync.ts` は静的カタログを期待状態、Twitterの `ListMembers` 全ページを取得した
スナップショットを観測状態として扱います。

```text
catalog (expected) ─┐
                    ├─> sync plan ─> dry-run output
ListMembers (live) ─┘       ├─ additions
                            ├─ removals
                            └─ unchanged
```

同期計画はTwitter内部IDで比較するため、ハンドル変更を別ユーザーとして扱いません。
スナップショットには `complete` があり、全ページを取得できていない場合は同期計画の
作成自体を拒否します。また、計画作成後にカタログが変わるとfingerprint不一致になり、
古い計画を適用できません。

通常の流れは次のとおりです。

1. `ListMembers` をBottom cursorまで読み、`RemoteListSnapshot`を保存する
2. `createListSyncPlan` で追加・削除差分を計算する
3. `formatListSyncPlan` の結果をレビューする
4. 明示的に承認されたexact syncスクリプトからだけRelayへ送信する
5. 送信後は `ListMembers` を再取得して期待状態と一致するか検証する

現在は1〜5と有限なtimeline read executorまで実装しています。リスト変更を送信する
GitHub Actions workflowはなく、live collectorは`ListLatestTweetsTimeline`のGETだけを許可します。

Relay request catalogのbase templateは
[`fa0311/twitter_api_safe_relay_skills` の `requests.ndjson`](https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson)
です。live workflowはレビュー済みcommit SHAと内容SHA-256を固定し、そのimmutableなbaseを
読みます。ただしX Web clientから再captureした実効version lockは
[`src/relay-overrides.ts`](src/relay-overrides.ts)で管理し、上流更新を待ちません。

ローカルoverrideは`queryId`、features、固定variablesをoperation単位で完全置換し、
実行時には`listId`、`userId`、`cursor`だけを重ねます。raw manifestにはbase catalogの
source、commit、内容SHA-256に加え、override集合SHA-256と適用後template SHA-256を保存します。
2026-08-18にcaptureしてoverrideしている操作は次のとおりです。

- `ListMembers`
- `ListAddMember`
- `ListRemoveMember`
- `ListLatestTweetsTimeline`

`CreateList`は現行captureがないため、上流baseを参照できますがlive実行には使用しません。
exact sync CLIは`ListRemoveMember`のreviewed local overrideがない場合、Relayへ接続する前に
fail closedします。

### 非公開リストのexact syncスクリプト

`scripts/sync-list-members.ts`は`account2`と非公開リスト`kasumilog`へ固定されています。
現在の`ListMembers`を全ページ取得し、activeカタログとの差分をTwitter ID順に追加した後、
管理外メンバーを削除します。最後に全ページを再取得し、active IDの不足と管理外IDがともに
0件であることを検証します。失敗時のretryは行わず、requestは15秒＋最大10秒jitterで
逐次実行します。

`ListRemoveMember`は現行X Web clientからquery ID、features、variablesを一体でcaptureしており、
古い上流templateではなくlocal overrideを使用します。

```sh
npm run list:sync-members -- /path/to/requests.ndjson
```

これは実際のTwitterリストを変更するため、Relayとbrowserが安定し、十分なディスク空き容量が
あることを確認してから明示的に実行します。

## 投稿アーカイブ

`src/archive.ts` は現在の正規化プロトタイプです。`ListLatestTweetsTimeline` の応答を
1投稿1行のNDJSONへ変換します。

- tweet IDで重複排除
- `firstCollectedAt`と`lastCollectedAt`を保持
- カタログ登録済みpublisherには既存の投稿メタデータを付与
- personal accountはカタログでレビューした`defaultDomain`（例: `politics`）で自動分類
- カタログ外publisherも捨てず、未分類のまま保存
- リポスト元は`repostOf`、引用元は`quoteOf`として別に保存
- リポスト元をタイムライン上のpublisherで上書きしない
- Bottom cursorを次ページ取得用として返す

このNDJSONをアーカイブの正本にはしません。完全なRelay応答本文を保存する前に
正規化すると、将来parserを修正しても捨てたフィールドを復元できないためです。

`src/raw.ts` はRelay response bodyを`Uint8Array`のままSHA-256 CASへ保存し、fetchごとの
immutable manifestを作成します。同一bodyはdedupeしますが、観測manifestは毎回残します。
request headerは受け取らず、response headerも明示allowlistだけを保存します。

`src/archive-git.ts`はraw pageをcommitしてnon-force pushし、別のclean cloneからmanifest、
body hash、bytesを再検証します。収集前にもbranch、remote HEAD、`data/raw`の作業状態を
preflightします。検証済みpage commitだけをrun manifestが参照します。
runnerが再実行された場合も、commit済みrunは新しいcommitを増やさず検証できます。

### Fixture収集CLI

実Twitterへ接続せず、raw保存からremote Git検証までを試せます。`DIR`は`archive` branchを
checkoutしたGit worktreeで、`origin`に同名branchをpushできる必要があります。

```sh
npm run collect:fixture -- \
  --fixture test/fixtures/list-timeline-page.capture.json \
  --repository DIR \
  --branch archive \
  --json
```

このCLIがstageできるのは`data/raw/objects`、`fetches`、`runs`だけです。各pageをpushして
remoteからreadbackした後にrun manifestを確定します。fixture smoke workflowは一時bare
remoteだけを使い、実リポジトリの`archive` branchを変更しません。

### Relay実行計画CLI

固定した`requests.ndjson`から、timeline requestの安全な実行計画だけを確認できます。
RelayへのHTTP requestは行わず、list ID、cursor、query valuesも出力しません。

```sh
npm run plan:timeline -- \
  --request-catalog /path/to/requests.ndjson \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --profile account2 \
  --list-id 1234567890 \
  --json
```

### Timeline収集CLI

指定したRelay browser profileで、既存のprivate Twitterリストを1回だけ有限収集します。
live workflowは実験用profileを`account2`へ固定します。これはlive readです。list ID、cursor、
tweet ID、raw bodyは標準出力へ出しません。pacing、retry、page上限を弱めるflagもありません。

```sh
npm run collect:timeline -- \
  --request-catalog /path/to/requests.ndjson \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --request-catalog-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --profile account2 \
  --list-id 1234567890 \
  --repository /path/to/archive-worktree \
  --branch archive \
  --json
```

通常は直接実行せず、後述の承認付きworkflowから呼び出します。

### ローカル検索POC

private `archive` branchをcheckoutした後、raw responseとcheckout中のparser/catalogから
使い捨てSQLiteを再生成します。SQLite、正規化データ、FTSはGitへ追加しません。

```sh
npm run search:rebuild -- \
  --raw-root data/raw \
  --database state/kasumilog.sqlite \
  --json

npm run search -- \
  --database state/kasumilog.sqlite \
  --query '内閣総理' \
  --limit 20 \
  --json
```

- 3文字以上の語はFTS5 `trigram`で候補を絞り、literal部分一致を確認
- 1〜2文字の「総理」「国会」などは`instr()` scanへfallback
- 並び順は`published_at DESC, tweet_id DESC`
- 次ページは結果の`nextCursor`を`--cursor`へ渡す
- `OFFSET`、relevance順、incremental migration、SQLiteのGit保存は行わない

初回は常にfull rebuildします。rawが増えた場合も、当面は同じコマンドでDBを作り直します。
DB内の`projection_meta`にはschema/parser version、catalog SHA-256、対象fetch件数を残します。
成功したtimeline responseをdecodeできない場合は部分DBへ置換せず、rebuild自体を失敗させます。

## Private raw収集構成

採用した設計では、完全なHTTP/GraphQL応答本文をimmutableなraw正本として保存し、
正規化データとFTSはrawから再構築できる派生物にします。

```text
GitHub Actions
  ├─ request生成 / pagination / pacing / backoff
  │
  ├─ ephemeral Tailscale node (tag:ci)
  │        └─ split DNS / HTTPS
  │             └─ https://tw.home.yutakobayashi.com
  │                    └─ Twitter Relay ──> X
  │
  └─ raw CAS / fetch manifest / run manifestをarchive branchへcommit
                                      │
                                      └─ 各利用者がSQLite + FTSをローカル構築
```

- live収集は現在`workflow_dispatch`だけを受け付け、pull requestやscheduleにはTailscale secretを渡さない
- `TS_OAUTH_CLIENT_ID`と`TS_OAUTH_SECRET`はrepository secretではなく、`archive-collection-live` Environmentに置く
- 現在のGitHub billing planはprivate repositoryのrequired reviewer、Environment branch policy、branch protectionを提供しないため、live workflowは`workflow_dispatch`とdefault-branch ref guardで制限する。より強いgateを用意するまでlive収集は実行しない
- `TWITTER_ARCHIVE_LIST_ID`も同Environmentのvariableとして設定する
- dotnixで宣言管理するkasumilog専用OAuth client、`tag:ci`、split DNSを使って実行ごとのephemeral nodeを作る
- runnerは既存の`https://tw.home.yutakobayashi.com`へ直接接続し、新しい宅内forwarderやspoolを追加しない
- tailnet identityはRelay全体へ到達できるため、信頼境界はprivate repositoryのdefault-branch workflowにも置く
- 収集clientは`GET ListLatestTweetsTimeline`だけを許可し、全requestへ明示した
  `x-profile-name`を付ける。live workflowは`account2`へ固定し、mutation requestを構築できない
- ActionsがRelay呼び出しを逐次化し、30秒＋最大15秒jitter、pagination、backoffを管理する
- responseを受けたActionsはraw CASとmanifestを先にarchive worktreeへ保存し、push後にだけ次のdurable frontierへ進む
- runner再起動後のfrontierと待機期限は、archive branchへcommit済みのfetch/run manifestから復元する
- 専用`archive` branchの`data/raw`だけをappend-onlyで更新する
- 正規化NDJSON、SQLite、FTS、exportはGitへ保存しない
- 各利用者はprivate rawからSQLite/FTSをローカル再構築する
- Twitter response schemaが変わってもrawを先に保存し、version付きparserを更新して再処理する
- リスト差分の適用は収集から分離したexact syncスクリプトだけが行う

設計判断は
[`docs/adr/0001-immutable-raw-and-local-projections.md`](docs/adr/0001-immutable-raw-and-local-projections.md)、
データ形式、Git durability、障害復旧、pagination、backoff、ローカルFTSまで含む詳細は
[`docs/design/archive-pipeline.md`](docs/design/archive-pipeline.md) に記載しています。

`archive-collection-plan.yml`はsanitize済みの実行計画を作るだけです。Tailscaleや
Environment secretsへアクセスせず、レビュー済みrequest catalog revisionとSHA-256を固定します。
`archive-collection-live.yml`はdefault branch ref guard、Environment secret分離、static concurrencyの下で、
trusted sourceと`archive` worktreeを分離してmanual収集できます。組み込み`GITHUB_TOKEN`の
`contents: write`はarchiveへのappend pushに使い、Git設定と収集stepだけで`GH_TOKEN`として参照します。このworkflowはまだ
実行しておらず、scheduleもありません。Twitterリスト変更はローカルのexact syncで実行済みですが、
変更を送信するGitHub Actions workflowはありません。
ローカルFTSはPOCとして実装済みで、raw schema対応や性能は実データを見て拡張します。

### 収集pagination・pacing・backoff

`src/collector.ts`とmanual workflowに実装済みですが、workflowはまだ実行していません。

- 初回は設定なしなら最新の有効な1ページだけをseedとして保存
- collector内部には有限な`bootstrapFrom`境界があるが、初回live CLI/workflowには公開しない
- 既定上限はtimeline 3ページ、8request、200投稿、10分
- cursorは同一run内だけで使用し、毎run timeline headから開始
- 2回目以降は前回frontierの既知tweet IDを再観測するか、その時刻より古い通常投稿まで
  通過した時点でoverlap成立として停止
- 通常・retryとも1requestずつ、応答後30秒＋0〜15秒jitter
- retryはnetwork/timeout、408、429、500、502、503、504だけ、1ページ最大3attempt
- `Retry-After`の秒数・HTTP-dateとrate-limit resetを優先
- headerがないretryは60秒基準、最大15分の指数full-jitter
- raw保存、Git push、clean clone readback検証の完了前にJSON解析結果や次cursorを使わない
- GraphQL errors、decode error、その他4xxはraw保存後に停止
- page/request/item/wall-clock上限では`partial`となりfrontierを更新しない

初回に過去全件を自動取得する経路はありません。古い固定表示投稿が混ざっても、それだけで
`bootstrapFrom`到達と判定しないようtimeline entry末尾を境界に使います。
本文一致は停止条件にしません。定型発信、リポスト、編集で別投稿が同じ本文になり得るため、
tweet IDと通常timeline entryの時刻だけをcoverage判定に使います。

## テスト

Node.js 22.13以降とGitで実行します。npmの外部パッケージは不要です。

```sh
npm test
```
