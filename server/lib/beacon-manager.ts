/**
 * Beacon Manager
 *
 * Agent SDK V1 query() を使用したBeaconチャット機能のセッション管理。
 * 単一のグローバルセッションを保持し、MessageQueueパターンで
 * マルチターン会話を実現する。全リポジトリを横断して操作可能。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  BeaconStreamChunk,
  ChatMessage,
  SpecialKey,
} from "../../shared/types.js";
import { db } from "./database.js";
import { getErrorMessage } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Beaconのシステムプロンプト */
const BEACON_SYSTEM_PROMPT = `あなたはArkのBeaconです。
複数のリポジトリを横断して管理するアシスタントです。

## MCPツール

Ark内部の操作にはMCPツールを使用してください:
- list_repositories: 全リポジトリ一覧
- list_worktrees: worktree一覧（全リポジトリまたは指定リポジトリ）
- list_sessions: アクティブセッション一覧
- start_session: セッション起動
- stop_session: セッション停止
- send_to_session: セッション内のClaude Codeにテキスト入力（Enter付き）
- send_key_to_session: セッションに特殊キー送信（y, n, C-c, Escape等）
- get_session_output: セッションのターミナル表示内容を取得（進捗確認に使用）
- create_worktree: worktree作成（リポジトリパス、ブランチ名、ベースブランチ）
- delete_worktree: worktree削除
- get_pr_url: worktreeのブランチに紐づくPR URLを取得
- gh_exec: gh CLIコマンドを実行（pr view, issue list, search等）
- get_system_status: ホストのCPU/load/メモリ/CPU上位プロセスを取得
- list_processes: 実行中プロセスを一覧（pattern指定で絞り込み）
- get_pm2_status: pm2管理プロセスの状態を取得
- restart_service: 運用サービスを再起動（'ttyd' のみ。Beacon自身も一時切断される）

git/gh操作はMCPツールを通じて実行してください。
worktreeの作成・削除はMCPツールを使ってください。

## コマンドフロー

ユーザーが以下のコマンドを送った場合、定義されたフローに従ってください。

### 「進捗確認」

リポジトリやセッションをユーザーに聞かず、即座に全セッションを走査して報告する。
**最も重要なのは「ユーザーの判断待ち」のセッションを最初に報告すること。**

1. list_sessionsで稼働中のセッション一覧を取得
2. **稼働中セッションがある場合**:
   - 全セッションのget_session_outputを実行
   - セッションを以下の優先度で分類・並べ替えて報告:
     1. **🔴 判断待ち**: y/n確認待ち、エラーで停止、レビュー結果の判断待ち、PR作成済みでマージ判断待ちなど、ユーザーのアクションが必要なもの
     2. **🟡 完了**: 作業が終わりアイドル状態。次の指示やworktree削除の判断が必要
     3. **🟢 作業中**: まだ作業が進行中で放置してよいもの
   - 判断待ちのセッションがある場合、最初に「**N件のセッションがあなたの判断を待っています**」と強調
   - 各セッションは見出し（### ブランチ名）で区切り、ビュレットリストで属性を表示
   - 判断待ちのセッションには次のアクションを番号付きリストで提示
3. **稼働中セッションがない場合**:
   - 「稼働中のセッションはありません」と報告
   - list_worktreesで全リポジトリのworktreeを取得し、番号付きリストで表示して「セッションを起動しますか？」と提案

### 「ホスト確認」「CPU高い」「重い」等の調査依頼

ホストの負荷状況を調査するフロー。ユーザーが「CPU高い」「ホスト重い」「動作が遅い」等と訴えた場合に発動する。

1. get_system_statusで現在のCPU/load/メモリと上位プロセスを取得
2. 異常を検出した場合、原因プロセスを特定:
   - ttyd系が暴走している場合は list_processes(pattern: "ttyd") で詳細確認
   - pm2管理プロセスの状態は get_pm2_status で確認
3. 結果を以下の形式で報告:
   ### ホスト状態
   - **load average**: x.xx / x.xx / x.xx
   - **CPU使用率上位**: 上位3件をビュレットで列挙
   - **判定**: 正常 / 要対処
   - **原因と推測**: ttyd暴走 / claude実行中 / 不明 等
4. **要対処** かつ **ttyd暴走** が原因の場合のみ、次のアクションを番号付きリストで提示:
   1. ttydを再起動する（restart_service("ttyd") を実行・Arkサーバーが一時的に再起動される）
5. それ以外の場合は推測に留め、勝手に再起動してはならない

### 「タスク着手」

ユーザーが思いついたタスクを壁打ちし、Issue/チケットを作成してからworktreeで着手させるフロー。
ユーザーの入力にURL（http:// または https://）が含まれる場合は Phase 1b（URL経由）に進む。含まれない場合は Phase 1a（壁打ち）に進む。

#### Phase 1a: 壁打ち（URLなしの場合）
1. list_repositoriesで全リポジトリ一覧を取得
2. 番号付きリストでリポジトリを提示し、ユーザーに選ばせる
3. ユーザーがリポジトリを選択したら、タスクの内容をヒアリング
   - 「どんなタスクですか？」と聞く
   - ユーザーの説明を深掘り・整理する（目的、スコープ、受入条件など）
   - 壁打ちが十分と判断したら「この内容でIssue/チケットを作成しますか？」と要約を提示
4. → Phase 2へ進む

#### Phase 1b: URL経由（URLありの場合）
ユーザーがチケット/IssueのURLを貼って着手を依頼した場合のフロー。チケット内容の取得とブランチ名提案はmainセッションのClaude Codeに委譲する（mainはJira MCP、gh CLI等のフルツールアクセスを持つため）。

1. list_repositoriesで全リポジトリ一覧を取得
2. 番号付きリストでリポジトリを提示し、ユーザーに選ばせる
3. 選択されたリポジトリのmainワークツリーを特定する
   - list_worktreesでisMain=trueのworktreeを探す
4. mainのセッションを確認・起動する
   - list_sessionsで既存セッションを確認。mainのworktreeに紐づくセッションがあれば:
     - get_session_outputで状態を確認し、入力待ち/アイドルの場合のみそのセッションを流用する
     - 作業中や判断待ちの場合は「mainセッションが使用中です。中断してよいですか？」とユーザーに確認する
   - セッションがなければstart_sessionでmainのセッションを起動
5. mainセッションにチケット内容取得とブランチ名提案を指示する
   - send_to_sessionで以下を送信:
     「以下のURLのチケット/Issue内容を取得し、以下の形式で回答してください。\n\n## タスク要約\n- タイトル: ...\n- 説明: ...\n- 受入条件: ...（あれば）\n\n## ブランチ名提案\nCLAUDE.mdのブランチ名ルールに従い、URLの種別（Jiraチケット / GitHub issue）に応じた形式で1つ提案してください。\n\nURL: {ユーザーが貼ったURL}」
6. mainセッションの出力を監視する
   - get_session_outputを数回ポーリングし、タスク要約とブランチ名提案を検出する
   - 検出できない場合は「内容を取得できませんでした。mainセッションの状態を確認してください」と報告して終了
7. 取得した内容をユーザーに表示して確認する
   - タスク要約とブランチ名案を表示し、「この内容で着手しますか？」と確認
→ 確認OK → Phase 3へ進む（壁打ちで整理した要約の代わりに、mainから取得したタスク要約を使う。ブランチ名もmainの提案を使う）

#### Phase 2: Issue/チケット作成（mainセッション経由、Phase 1aからのみ）
4. 選択されたリポジトリのmainワークツリーを特定する
   - list_worktreesでisMain=trueのworktreeを探す
5. mainのセッションを確認・起動する
   - list_sessionsで既存セッションを確認。mainのworktreeに紐づくセッションがあれば:
     - get_session_outputで状態を確認し、入力待ち/アイドルの場合のみそのセッションを流用する
     - 作業中や判断待ちの場合は「mainセッションが使用中です。中断してよいですか？」とユーザーに確認する
   - セッションがなければstart_sessionでmainのセッションを起動
6. mainセッションにIssue/チケット作成を指示する
   - send_to_sessionで以下を送信:
     「以下のタスクのIssue（またはチケット）を作成してください。作成先はプロジェクトの設定に従ってください。\n\nタスク内容:\n{壁打ちで整理した要約}\n\n作成したIssue/チケットの識別子（例: #123 や PROJ-123）とURLを教えてください。\nまた、CLAUDE.mdのブランチ名ルールに従い、作成先の種別（Jiraチケット / GitHub issue）に応じた形式で適切なブランチ名を1つ提案してください。」
7. mainセッションの出力を監視する
   - get_session_outputを数回ポーリングし、Issue/チケットの識別子・URLとブランチ名提案を検出する
   - 見つかったらユーザーに報告: 「{識別子} を作成しました」（ブランチ名提案も合わせて取得しておく）

#### Phase 3: worktree作成＆タスク着手（Phase 1b / Phase 2 共通）
8. mainセッションが提案したブランチ名をユーザーに確認する
   - 「このブランチ名でよいですか？ {ブランチ名}」
9. 確認が取れたら:
   - create_worktreeでworktreeを作成（返り値にworktreeのIDとパスが含まれる）
   - start_sessionでセッションを起動（create_worktreeの返り値のidとpathを使う）
   - send_to_sessionでタスク内容 + チケットURL（Phase 1bはユーザーが貼ったURL、Phase 1aはPhase 2で作成したURL）をClaude Codeに入力
10. 「セッションを起動してタスクを指示しました。進捗確認で状況を確認できます。」と報告

### 「PR URL」

稼働中セッションのブランチに紐づくPR URLを取得するフロー。

1. list_sessionsで稼働中のセッション一覧を取得
2. **セッションが1つ**: そのセッションのworktreeパスで gh pr view --json url -q .url をBashで実行
3. **セッションが複数**: 番号付きリストで選択肢を提示。ユーザーが選択したらそのworktreeパスで実行
4. **セッションがない場合**: 「稼働中のセッションはありません」と報告
5. PR URLが取得できたらそのまま表示。PRがない場合は「このブランチにPRはありません」と報告

### 「判断」

worktreeを増やさないために、完了に最も近いセッションを特定して次のアクションを提案するフロー。

1. list_sessionsで全稼働中セッション一覧を取得
2. 全セッションのget_session_outputを実行してtty内容を読み取る
3. 各セッションの完了度を以下の基準で判定:
   - **完了/アイドル**: Claude Codeが入力待ち状態（プロンプトが表示されている）、作業が終わっている
   - **ほぼ完了**: テスト実行中、PR作成待ち、最終確認中
   - **作業中**: ファイル編集中、コード生成中
   - **ブロック中**: エラーで止まっている、y/n確認待ち
4. 完了に最も近いセッション1つをピックアップする
5. そのセッションがレビュー待ち・PR作成済み・マージ判断待ちなど「人間のレビューが必要」な状態の場合:
   - gh_execで \`gh pr view --json url -q .url\` を実行してPR URLを取得する（cwdにはそのセッションのworktreeパスを指定すること）
   - PR URLが取得できたら報告に含める
6. 以下の形式で報告:

### ブランチ名
- **状態**: 完了/アイドル
- **作業内容**: 何をしていたか
- **完了までに必要なこと**: 残タスク
- **PR**: URL（PRがある場合のみ表示）

次のアクション:（※必ず番号付きリストで書くこと。1と2は排他的で、PR URLの有無に応じて該当するもののみ表示すること）
1. PRをレビューする（PR URLを取得できた場合のみ）
2. PRを作成する（PRがない場合のみ）
3. テストを実行させる

（注意: 「次のアクション」のリストは絶対にビュレットリスト（-）で書いてはならない。必ず番号付きリスト（1. 2. 3.）で書くこと。番号付きリストはタップ可能なボタンとしてレンダリングされる）

7. セッションがない場合は「稼働中のセッションはありません」と報告

### 進捗報告のフォーマット

get_session_outputで取得したターミナル内容を読み解き、以下の形式で簡潔に報告:

### ブランチ名
- **状態**: 作業中 / 入力待ち / エラー / 完了
- **作業内容**: 何をしているか
- **直近の出力**: 重要な出力があれば1行で要約
- **必要なアクション**: ユーザーの操作が必要な場合のみ記載

## 回答フォーマット

**重要: 番号付きリストとビュレットリストの使い分け**

- **番号付きリスト（1. / 2. / 3.）**: ユーザーに選択を求める場合**のみ**使用。UIでタップ可能なボタンとしてレンダリングされる
- **ビュレットリスト（- ）**: 情報表示用。状態報告、属性一覧、説明に使う
- **見出し（### ）**: セッションやブランチの区切りに使う

情報を表示するだけの場面で番号付きリストを絶対に使わないこと。番号付きリストは「ユーザーが次に取る行動の選択肢」にのみ使用する。

その他:
- 回答は簡潔に、モバイルで読みやすい形式で返す
- パス、コミットハッシュなどの技術的な詳細は表示しない
- ブランチ名と状態だけを簡潔に表示`;

/** アイドルタイムアウト: 30分 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** アイドルチェック間隔: 5分 */
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// MessageQueue: push方式のAsyncIterableでquery()にユーザーメッセージを供給する
// ---------------------------------------------------------------------------

class MessageQueue {
  private messages: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private _closed = false;

  /** ユーザーメッセージをキューに追加する */
  push(content: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.messages.push(msg);
    }
  }

  /** キューを閉じる。待機中のPromiseも解決する */
  close(): void {
    this._closed = true;
    // 待機中のPromiseがあれば、空メッセージで解決して
    // イテレータのwhileループを終了させる
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // close後はイテレータのwhileループが _closed をチェックして終了する
      // ダミーメッセージで解決するが、yieldされない（ループ条件で弾かれる）
      resolve({
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: "" },
      });
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (!this._closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        const msg = await new Promise<SDKUserMessage>(resolve => {
          this.waiting = resolve;
        });
        // close()で解決された場合はyieldせずにループを抜ける
        if (this._closed) break;
        yield msg;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BeaconSession: グローバルに1つのセッション
// ---------------------------------------------------------------------------

interface BeaconSession {
  /** メッセージ供給キュー */
  queue: MessageQueue;
  /** query()から取得したAsyncIterator（出力読み取り用） */
  outputIterator: AsyncIterator<SDKMessage>;
  /** query()オブジェクト（interrupt等の制御用） */
  queryInstance: Query;
  /** チャット履歴 */
  messages: ChatMessage[];
  /** 最終アクティビティ時刻 */
  lastActivity: Date;
  /**
   * 出力処理ループが起動中かどうか (processOutput の再入防止用)。
   * Beacon セッションが生きている間はずっと true。
   * postExternalMessage の defer 判定には使えない (常時 true のため queue が
   * 永遠に flush されない) → activeTurn を見ること。
   */
  processing: boolean;
  /**
   * 進行中の turn 数 (queue+streaming中の合計)。
   * sendMessage で +1、processOutput の result message ごとに -1。
   * 多数 turn が queue されているケース (multi-client) でも、count > 0 の
   * 間は postExternalMessage を defer する必要がある。boolean では
   * 1回目の result で false になってしまい、後続 turn 中の usage 投稿が
   * 即時 emit/persist されて順序崩壊するため counter を使う。
   */
  activeTurnCount: number;
  /** AbortController（セッション終了時にquery()を中断するため） */
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// BeaconManager: 単一のグローバルBeaconセッションを管理する
// ---------------------------------------------------------------------------

/** Beaconが利用するArk操作の依存インターフェース */
export interface BeaconDeps {
  getAllSessions: () => unknown[];
  startSession: (worktreeId: string, worktreePath: string) => Promise<unknown>;
  stopSession: (
    sessionId: string
  ) => { worktreePath: string; repoPath?: string } | null;
  sendMessage: (sessionId: string, message: string) => void;
  sendKey: (sessionId: string, key: SpecialKey) => void;
  capturePane: (sessionId: string, lines?: number) => string | null;
  getPrUrl: (worktreePath: string) => Promise<string | null>;
  listWorktrees: (repoPath: string) => Promise<unknown[]>;
  listAllWorktrees: (repos: string[]) => Promise<unknown[]>;
  createWorktree: (
    repoPath: string,
    branchName: string,
    baseBranch?: string
  ) => Promise<unknown>;
  deleteWorktree: (repoPath: string, worktreePath: string) => Promise<void>;
  getRepos: () => string[];
}

export class BeaconManager extends EventEmitter {
  private session: BeaconSession | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private deps: BeaconDeps | null = null;
  /**
   * Beacon が assistant 応答を streaming 中に postExternalMessage が呼ばれた場合
   * のキュー。LLM turn の timestamp は完了時に確定するため、turn 完了前に
   * 外部メッセージを保存すると DB 上の順序が逆転する。turn 完了後にまとめて
   * flush する。
   */
  private pendingExternalMessages: ChatMessage[] = [];
  /**
   * 履歴の世代カウンタ。clearHistory で +1 する。
   * /usage のような長時間バックグラウンド処理が、終了時点で
   * 履歴がクリア済みかを判定するために使う (capture → complete 時に比較)。
   */
  private historyVersion = 0;

  constructor() {
    super();
    this.startIdleCheck();
  }

  /**
   * MCPツールが呼び出すArk操作の依存を注入する。
   * server/index.ts でサーバー初期化後に呼び出すこと。
   */
  configure(deps: BeaconDeps): void {
    this.deps = deps;
    console.log("[BeaconManager] 依存を注入しました");
  }

  /**
   * MCPサーバーを作成する。
   * BeaconエージェントがArk操作をネイティブツールとして呼び出せるようにする。
   */
  private createMcpServer() {
    if (!this.deps) {
      throw new Error("BeaconManager が configure() されていません");
    }
    const deps = this.deps;

    const ALLOWED_GH_COMMANDS = new Set([
      "pr list",
      "pr view",
      "pr checks",
      "pr diff",
      "pr status",
      "issue list",
      "issue view",
      "issue status",
      "search prs",
      "search issues",
      "search repos",
      "run list",
      "run view",
      "workflow list",
      "workflow view",
      "release list",
      "release view",
      "label list",
      "repo view",
      "status",
    ]);

    return createSdkMcpServer({
      name: "ark-beacon",
      version: "1.0.0",
      tools: [
        {
          name: "list_repositories",
          description: "Arkに登録されている全リポジトリを一覧する",
          inputSchema: {},
          handler: async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(deps.getRepos(), null, 2),
              },
            ],
          }),
        },
        {
          name: "list_worktrees",
          description:
            "指定リポジトリ（または全リポジトリ）のworktreeを一覧する",
          inputSchema: {
            repoPath: z
              .string()
              .optional()
              .describe("リポジトリパス（省略時は全リポジトリ）"),
          },
          handler: async args => {
            const repoPath = args.repoPath as string | undefined;
            if (repoPath) {
              const worktrees = await deps.listWorktrees(repoPath);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(worktrees, null, 2),
                  },
                ],
              };
            }
            const worktrees = await deps.listAllWorktrees(deps.getRepos());
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(worktrees, null, 2),
                },
              ],
            };
          },
        },
        {
          name: "list_sessions",
          description:
            "現在アクティブなClaude Codeターミナルセッション一覧を取得する",
          inputSchema: {},
          handler: async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(deps.getAllSessions(), null, 2),
              },
            ],
          }),
        },
        {
          name: "start_session",
          description:
            "指定worktreeでClaude Codeターミナルセッションを起動する",
          inputSchema: {
            worktreeId: z.string().describe("worktreeのID"),
            worktreePath: z.string().describe("worktreeのパス"),
          },
          handler: async args => {
            const worktreeId = args.worktreeId as string;
            const worktreePath = args.worktreePath as string;
            const session = await deps.startSession(worktreeId, worktreePath);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(session, null, 2),
                },
              ],
            };
          },
        },
        {
          name: "stop_session",
          description: "Claude Codeターミナルセッションを停止する",
          inputSchema: {
            sessionId: z.string().describe("セッションID"),
          },
          handler: async args => {
            const sessionId = args.sessionId as string;
            deps.stopSession(sessionId);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `セッション ${sessionId} を停止しました`,
                },
              ],
            };
          },
        },
        {
          name: "send_to_session",
          description:
            "稼働中のClaude Codeターミナルセッションにテキストを送信する（Enter付き）",
          inputSchema: {
            sessionId: z.string().describe("セッションID"),
            message: z.string().describe("送信するテキスト"),
          },
          handler: async args => {
            deps.sendMessage(args.sessionId as string, args.message as string);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `セッション ${args.sessionId} にメッセージを送信しました`,
                },
              ],
            };
          },
        },
        {
          name: "send_key_to_session",
          description:
            "稼働中のClaude Codeターミナルセッションに特殊キーを送信する（y, n, C-c, Escape, Enter など）",
          inputSchema: {
            sessionId: z.string().describe("セッションID"),
            key: z
              .string()
              .describe("送信するキー（y, n, C-c, Escape, Enter, S-Tab）"),
          },
          handler: async args => {
            const validKeys = new Set([
              "Enter",
              "C-c",
              "C-d",
              "y",
              "n",
              "S-Tab",
              "Escape",
            ]);
            const key = args.key as string;
            if (!validKeys.has(key)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `無効なキー: ${key}。使用可能: ${Array.from(validKeys).join(", ")}`,
                  },
                ],
              };
            }
            deps.sendKey(args.sessionId as string, key as SpecialKey);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `セッション ${args.sessionId} にキー「${key}」を送信しました`,
                },
              ],
            };
          },
        },
        {
          name: "get_session_output",
          description:
            "稼働中のClaude Codeターミナルセッションの現在の表示内容を取得する。進捗確認に使用する。",
          inputSchema: {
            sessionId: z.string().describe("セッションID"),
            lines: z
              .number()
              .optional()
              .describe("取得する行数（デフォルト: 100）"),
          },
          handler: async args => {
            const output = deps.capturePane(
              args.sessionId as string,
              (args.lines as number | undefined) ?? 100
            );
            if (output === null) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "セッションが見つからないか、出力を取得できませんでした",
                  },
                ],
              };
            }
            return { content: [{ type: "text" as const, text: output }] };
          },
        },
        {
          name: "create_worktree",
          description: "リポジトリに新しいworktreeを作成する",
          inputSchema: {
            repoPath: z.string().describe("リポジトリのパス"),
            branchName: z
              .string()
              .describe("ブランチ名（例: feat/add-search, fix/login-bug）"),
            baseBranch: z
              .string()
              .optional()
              .describe("ベースブランチ（省略時はHEAD）"),
          },
          handler: async args => {
            try {
              const worktree = await deps.createWorktree(
                args.repoPath as string,
                args.branchName as string,
                args.baseBranch as string | undefined
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(worktree, null, 2),
                  },
                ],
              };
            } catch (e) {
              return {
                content: [
                  { type: "text" as const, text: `worktree作成に失敗: ${e}` },
                ],
              };
            }
          },
        },
        {
          name: "delete_worktree",
          description: "worktreeを削除する",
          inputSchema: {
            repoPath: z.string().describe("リポジトリのパス"),
            worktreePath: z.string().describe("削除するworktreeのパス"),
          },
          handler: async args => {
            try {
              await deps.deleteWorktree(
                args.repoPath as string,
                args.worktreePath as string
              );
              return {
                content: [
                  { type: "text" as const, text: "worktreeを削除しました" },
                ],
              };
            } catch (e) {
              return {
                content: [
                  { type: "text" as const, text: `worktree削除に失敗: ${e}` },
                ],
              };
            }
          },
        },
        {
          name: "get_pr_url",
          description: "worktreeのブランチに紐づくPull Request URLを取得する",
          inputSchema: {
            worktreePath: z.string().describe("worktreeのパス"),
          },
          handler: async args => {
            const url = await deps.getPrUrl(args.worktreePath as string);
            if (url) {
              return {
                content: [{ type: "text" as const, text: url }],
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: "このブランチにPRはありません",
                },
              ],
            };
          },
        },
        {
          name: "get_system_status",
          description:
            "ホストのCPU使用率/load average/メモリ/CPU上位プロセスを取得する。「CPU高い」「ホスト重い」等の調査に使う。",
          inputSchema: {
            topN: z
              .number()
              .optional()
              .describe("CPU使用率上位N件のプロセスを表示（デフォルト: 10）"),
          },
          handler: async args => {
            try {
              const topN = (args.topN as number | undefined) ?? 10;
              const os = await import("node:os");
              const total = os.totalmem();
              const free = os.freemem();
              const used = total - free;
              const load = os.loadavg();
              const cpus = os.cpus().length;
              const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
              // ps でCPU使用率上位を取得
              const { stdout } = await execFileAsync(
                "ps",
                [
                  "-eo",
                  "pid,pcpu,pmem,etime,comm",
                  "--sort=-pcpu",
                  "--no-headers",
                ],
                { timeout: 10_000, maxBuffer: 256 * 1024 }
              );
              const procLines = stdout
                .trim()
                .split("\n")
                .slice(0, topN)
                .map(l => l.trim());
              const summary = [
                `CPU cores: ${cpus}`,
                `Load average: ${load.map(n => n.toFixed(2)).join(", ")} (1/5/15min)`,
                `Memory: used ${fmtMb(used)} / total ${fmtMb(total)} (free ${fmtMb(free)})`,
                "",
                `Top ${topN} processes by CPU:`,
                "PID    %CPU %MEM ELAPSED  COMMAND",
                ...procLines,
              ].join("\n");
              return {
                content: [{ type: "text" as const, text: summary }],
              };
            } catch (e) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `system status取得エラー: ${getErrorMessage(e)}`,
                  },
                ],
              };
            }
          },
        },
        {
          name: "list_processes",
          description:
            "実行中プロセスを一覧する。pattern指定で特定プロセス（ttyd等）に絞り込み可能。",
          inputSchema: {
            pattern: z
              .string()
              .optional()
              .describe(
                "プロセス名/コマンドラインの部分一致パターン（例: ttyd, tmux）"
              ),
          },
          handler: async args => {
            try {
              const pattern = args.pattern as string | undefined;
              const { stdout } = await execFileAsync(
                "ps",
                ["-eo", "pid,pcpu,pmem,etime,cmd", "--no-headers"],
                { timeout: 10_000, maxBuffer: 1024 * 1024 }
              );
              let lines = stdout.trim().split("\n");
              if (pattern) {
                const lower = pattern.toLowerCase();
                lines = lines.filter(l => l.toLowerCase().includes(lower));
              }
              // 上位50件に制限（出力サイズ抑制）
              const limited = lines.slice(0, 50);
              const text =
                limited.length === 0
                  ? "該当プロセスなし"
                  : ["PID    %CPU %MEM ELAPSED  COMMAND", ...limited].join(
                      "\n"
                    );
              return {
                content: [{ type: "text" as const, text }],
              };
            } catch (e) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `プロセス一覧取得エラー: ${getErrorMessage(e)}`,
                  },
                ],
              };
            }
          },
        },
        {
          name: "get_pm2_status",
          description: "pm2で管理されているプロセス一覧と状態を取得する。",
          inputSchema: {},
          handler: async () => {
            try {
              const { stdout } = await execFileAsync("pm2", ["jlist"], {
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
              });
              const procs = JSON.parse(stdout) as Array<{
                name: string;
                pid: number;
                pm2_env?: {
                  status?: string;
                  pm_uptime?: number;
                  restart_time?: number;
                };
                monit?: { cpu?: number; memory?: number };
              }>;
              const summary = procs.map(p => {
                const status = p.pm2_env?.status ?? "unknown";
                const cpu = p.monit?.cpu ?? 0;
                const memMb = ((p.monit?.memory ?? 0) / 1024 / 1024).toFixed(1);
                const restarts = p.pm2_env?.restart_time ?? 0;
                return `- ${p.name} (pid ${p.pid}): ${status}, CPU ${cpu}%, MEM ${memMb}MB, restarts ${restarts}`;
              });
              const text =
                procs.length === 0 ? "pm2管理プロセスなし" : summary.join("\n");
              return {
                content: [{ type: "text" as const, text }],
              };
            } catch (e) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `pm2状態取得エラー: ${getErrorMessage(e)}`,
                  },
                ],
              };
            }
          },
        },
        {
          name: "restart_service",
          description:
            "事前定義された運用サービスを再起動する。許可: 'ttyd' のみ（pkill -f ttyd 後にArkサーバーをpm2 restartする。Beacon自身も一時的に切断される）。",
          inputSchema: {
            service: z.string().describe("再起動対象。現在は 'ttyd' のみ許可"),
          },
          handler: async args => {
            const service = args.service as string;
            if (service !== "ttyd") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `許可されていないサービス: ${service}。現在は 'ttyd' のみ許可`,
                  },
                ],
              };
            }
            try {
              // pkill は対象なし(exit 1)でもエラー扱いしない
              await execFileAsync("pkill", ["-f", "ttyd"], {
                timeout: 5_000,
              }).catch(err => {
                const code = (err as { code?: number }).code;
                if (code !== 1) throw err;
              });
              // 短い待機後にpm2 restart
              await new Promise(r => setTimeout(r, 1500));
              const { stdout } = await execFileAsync(
                "pm2",
                ["restart", "claude-code-ark"],
                { timeout: 30_000 }
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `ttydを停止しArkサーバーを再起動しました\n${stdout.trim()}`,
                  },
                ],
              };
            } catch (e) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `再起動失敗: ${getErrorMessage(e)}`,
                  },
                ],
              };
            }
          },
        },
        {
          name: "gh_exec",
          description:
            "gh CLIコマンドを実行する（読み取り専用コマンドのみ許可）",
          inputSchema: {
            args: z
              .array(z.string())
              .describe(
                'ghサブコマンドと引数（例: ["pr", "view", "--json", "url"]）'
              ),
            cwd: z
              .string()
              .optional()
              .describe("実行ディレクトリ（省略時はHOME）"),
          },
          handler: async params => {
            const args = params.args as string[];
            // コマンドキーを構築（"pr view", "status" 等）
            const commandKey =
              args.length >= 2 ? `${args[0]} ${args[1]}` : args[0] || "";
            // -R/--repo フラグを拒否
            if (args.includes("-R") || args.includes("--repo")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "--repo/-R フラグは許可されていません。cwdで対象リポジトリを指定してください",
                  },
                ],
              };
            }
            if (!ALLOWED_GH_COMMANDS.has(commandKey)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `許可されていないコマンドです。使用可能: ${Array.from(ALLOWED_GH_COMMANDS).join(", ")}`,
                  },
                ],
              };
            }
            try {
              const cwd = (params.cwd as string) || process.env.HOME || "/home";
              const { stdout, stderr } = await execFileAsync("gh", args, {
                cwd,
                timeout: 30_000,
                maxBuffer: 512 * 1024,
              });
              const output = stdout || "(出力なし)";
              return {
                content: [{ type: "text" as const, text: output }],
              };
            } catch (e: unknown) {
              const stderr = (e as { stderr?: string }).stderr;
              const errorMsg = stderr || getErrorMessage(e);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `gh コマンド実行エラー: ${errorMsg}`,
                  },
                ],
              };
            }
          },
        },
      ],
    });
  }

  /**
   * アイドルセッションの定期チェックを開始する
   */
  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      this.cleanupIdleSession();
    }, IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * アイドルタイムアウトを超えたセッションを閉じる
   */
  private cleanupIdleSession(): void {
    if (!this.session) return;
    const now = Date.now();
    const idleMs = now - this.session.lastActivity.getTime();
    if (idleMs > IDLE_TIMEOUT_MS) {
      console.log(
        `[BeaconManager] セッションがアイドルタイムアウト (${Math.round(idleMs / 60000)}分)`
      );
      this.closeSession();
    }
  }

  /**
   * 新しいBeaconセッションを開始する
   *
   * 既にセッションが存在する場合はそのまま返す。
   */
  startSession(): BeaconSession {
    if (this.session) {
      console.log("[BeaconManager] 既存セッションを再利用");
      return this.session;
    }

    const cwd = process.env.HOME || "/home";
    console.log(`[BeaconManager] 新規グローバルセッション開始 (cwd: ${cwd})`);

    const queue = new MessageQueue();
    const abortController = new AbortController();

    // MCPサーバーを作成（依存が注入されている場合のみ）
    const mcpServers = this.deps
      ? { "ark-beacon": this.createMcpServer() }
      : undefined;

    // V1 query() にAsyncIterableを渡してマルチターン会話を確立する
    const q = query({
      prompt: queue,
      options: {
        cwd,
        model: "sonnet",
        allowedTools: [
          "Read",
          "Grep",
          "Glob",
          // MCPツールを自動承認
          "mcp__ark-beacon__list_repositories",
          "mcp__ark-beacon__list_worktrees",
          "mcp__ark-beacon__list_sessions",
          "mcp__ark-beacon__start_session",
          "mcp__ark-beacon__stop_session",
          "mcp__ark-beacon__send_to_session",
          "mcp__ark-beacon__send_key_to_session",
          "mcp__ark-beacon__get_session_output",
          "mcp__ark-beacon__create_worktree",
          "mcp__ark-beacon__delete_worktree",
          "mcp__ark-beacon__get_pr_url",
          "mcp__ark-beacon__gh_exec",
          "mcp__ark-beacon__get_system_status",
          "mcp__ark-beacon__list_processes",
          "mcp__ark-beacon__get_pm2_status",
          "mcp__ark-beacon__restart_service",
        ],
        permissionMode: "default",
        systemPrompt: BEACON_SYSTEM_PROMPT,
        maxTurns: 50,
        abortController,
        ...(mcpServers ? { mcpServers } : {}),
      },
    });

    // DBから既存の履歴をロード（UI表示用・LLMコンテキストは引き継がない）
    const messages = db.getBeaconMessages();

    const session: BeaconSession = {
      queue,
      outputIterator: q[Symbol.asyncIterator](),
      queryInstance: q,
      messages,
      lastActivity: new Date(),
      processing: false,
      activeTurnCount: 0,
      abortController,
    };

    this.session = session;
    return session;
  }

  /**
   * メッセージを送信し、出力をストリーミングで返す
   *
   * 1. ユーザーメッセージをキューにpush
   * 2. beacon:message イベントでユーザーメッセージを通知
   * 3. 出力イテレータからSDKMessageを読み取り、ストリーミングで通知
   */
  async sendMessage(message: string): Promise<void> {
    if (!this.session) {
      // セッションが存在しない場合は自動的に開始する
      this.startSession();
    }

    const session = this.session!;

    // アクティビティ時刻を更新
    session.lastActivity = new Date();

    // ユーザーメッセージをチャット履歴に追加して通知
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: message,
      timestamp: new Date(),
    };
    session.messages.push(userMessage);
    db.addBeaconMessage(userMessage);
    this.emit("beacon:message", userMessage);

    // キューにメッセージをpush（query()のAsyncIterableに供給される）
    session.queue.push(message);

    // この turn が完了 (result message 受信) するまで activeTurnCount を
    // 増やす。multi-client で複数 turn が queue されると count が積まれ、
    // 全 turn の result が揃って 0 に戻るまで postExternalMessage は defer。
    session.activeTurnCount += 1;

    // 出力の処理を開始
    await this.processOutput();
  }

  /**
   * 出力イテレータからSDKMessageを読み取り、イベントとして通知する
   *
   * assistantメッセージのテキストコンテンツを抽出し、
   * ストリーミングチャンクとして送信する。
   */
  private async processOutput(): Promise<void> {
    const session = this.session;
    if (!session) return;

    // 既に処理中の場合はスキップ（重複呼び出し防止）
    if (session.processing) return;
    session.processing = true;

    try {
      // アシスタントの応答テキストを蓄積するバッファ
      let assistantText = "";
      // ツール使用情報を保持する
      let lastToolUse: ChatMessage["toolUse"] | undefined;

      // テキスト結合時に改行が欠けている場合を補完するヘルパー
      const appendWithNewline = (base: string, chunk: string): string => {
        if (base && !base.endsWith("\n") && !chunk.startsWith("\n")) {
          return `${base}\n${chunk}`;
        }
        return base + chunk;
      };

      while (true) {
        const { value, done } = await session.outputIterator.next();
        if (done) break;

        const msg = value as SDKMessage;

        if (msg.type === "assistant") {
          // BetaMessageのcontentからテキストを抽出
          for (const block of msg.message.content) {
            if (block.type === "text") {
              const chunk = block.text;
              // テキストブロック間に改行が欠けている場合を補完
              // （ツール実行前後のテキストが直結されるとMarkdownの行頭パターンが壊れる）
              const prevLen = assistantText.length;
              assistantText = appendWithNewline(assistantText, chunk);
              const effectiveChunk = assistantText.slice(prevLen);

              // ストリーミングチャンクを送信
              const streamChunk: BeaconStreamChunk = {
                chunk: effectiveChunk,
                done: false,
              };
              this.emit("beacon:stream", streamChunk);
            } else if (block.type === "tool_use") {
              // ツール使用情報を記録
              lastToolUse = {
                toolName: block.name,
                input:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input),
              };
            }
          }

          // assistantメッセージが1ターン完了した時点で次のメッセージを待つ
          // query()はツール実行後に再度assistantメッセージを返すため、
          // resultメッセージが来るまでループを継続する
          continue;
        }

        if (msg.type === "result") {
          // 結果メッセージ: ターン完了
          // resultメッセージ自体にもresultテキストが含まれる場合がある
          if (msg.subtype === "success" && "result" in msg && msg.result) {
            // resultのテキストがassistantTextに含まれていない場合のみ追加
            if (!assistantText.includes(msg.result)) {
              const prevLen = assistantText.length;
              assistantText = appendWithNewline(assistantText, msg.result);
              const effectiveChunk = assistantText.slice(prevLen);
              const streamChunk: BeaconStreamChunk = {
                chunk: effectiveChunk,
                done: false,
              };
              this.emit("beacon:stream", streamChunk);
            }
          }

          // 最終的なアシスタントメッセージをチャット履歴に追加
          // clearHistory等でセッションが差し替わっている場合はDB書き込みしない
          // （消した履歴が in-flight のresult書き込みで復活するのを防ぐ）
          if (assistantText && this.session === session) {
            const assistantMessage: ChatMessage = {
              id: randomUUID(),
              role: "assistant",
              content: assistantText,
              timestamp: new Date(),
              toolUse: lastToolUse,
            };
            session.messages.push(assistantMessage);
            db.addBeaconMessage(assistantMessage);
            this.emit("beacon:message", assistantMessage);
          }

          // 完了チャンクを送信
          const doneChunk: BeaconStreamChunk = {
            chunk: "",
            done: true,
          };
          this.emit("beacon:stream", doneChunk);

          // turn 完了 → activeTurnCount を 1 減らす。decrement 後に 0 なら
          // flushPendingExternalMessages を呼ぶ。順序が逆だと 1→0 遷移時に
          // flush されず pending が滞留する (CodeRabbit 指摘)。
          // multi-client で複数 turn が queue されている場合、最後の
          // result まで count > 0 のままなので、後続 turn 中の
          // postExternalMessage は引き続き pending queue に入る (順序保護)。
          if (this.session === session) {
            session.activeTurnCount = Math.max(0, session.activeTurnCount - 1);
            if (session.activeTurnCount === 0) {
              this.flushPendingExternalMessages();
            }
          }

          // このターンの処理完了。ループを継続して次のターンの出力を待つ
          // （キューに新しいメッセージがpushされるとquery()が新しい出力を生成する）
          assistantText = "";
          lastToolUse = undefined;
        }

        // system, tool_progress 等のメッセージは現時点ではスキップ
        // 必要に応じてここで追加の処理を実装可能
      }
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error("[BeaconManager] 出力処理エラー:", errorMsg);
      this.emit("beacon:error", { error: errorMsg });

      // エラー時も完了チャンクを送信してクライアント側のローディングを解除する
      const errorChunk: BeaconStreamChunk = {
        chunk: "",
        done: true,
      };
      this.emit("beacon:stream", errorChunk);
    } finally {
      if (session) {
        session.processing = false;
        // activeTurnCount は通常 result message 受信時に decrement するが、
        // query() throw / abort / iterator 終了などでそこへ到達できない
        // ケースもある。finally で必ず 0 に戻し、後続 postExternalMessage
        // が「streaming中」と誤判定して queue 滞留しないようにする。
        session.activeTurnCount = 0;
      }
      // エラー / 中断パスでも pending external messages が滞留しないよう
      // 必ず flush。assistant 応答が無くても外部メッセージはユーザに届ける。
      this.flushPendingExternalMessages();
    }
  }

  /**
   * 外部システム（Usage取得など）からassistantメッセージを投稿する。
   *
   * 用途: LLM経由ではなく、Arkの内部処理結果（例: 全プロファイル使用量サマリ）を
   * Beaconの履歴UIに表示するためのバイパスAPI。
   *
   * 注意1: このメソッドで投稿したメッセージは LLMコンテキストには注入されない。
   * BeaconManagerは履歴UIをDBから読み出すので、このメッセージは履歴画面には残るが、
   * 次回のBeacon会話で参照されることはない（履歴をリセットして新規セッションを
   * 開始する設計のため）。
   *
   * 注意2: `beacon:message` イベントは emit しない。BeaconManagerの通常emitは
   * activeBeaconSocket にしか転送されないため、Usage取得時のように Beacon未利用
   * 状態でも全クライアントに届けたい用途では呼び出し側が io.emit で broadcast
   * する責務を持つ。返り値の ChatMessage を使って呼び出し側で配信すること。
   */
  /**
   * 現在の履歴世代を取得する。
   * /usage のような長時間バックグラウンド処理は開始時にこの値を capture
   * しておき、完了時に `postExternalMessage(content, expectedVersion)` を
   * 呼ぶことで、その間に clearHistory された場合の汚染を回避できる。
   */
  getHistoryVersion(): number {
    return this.historyVersion;
  }

  /**
   * 外部メッセージを Beacon 履歴に投稿する。
   * @param expectedVersion 開始時の `getHistoryVersion()` 値。指定時、現在の
   *   世代と異なれば (= clearHistory 経由で履歴がリセット済み) 何もせず null
   *   を返す。指定なしなら無条件で投稿する (旧API互換)。
   */
  postExternalMessage(
    content: string,
    expectedVersion?: number
  ): ChatMessage | null {
    if (
      expectedVersion !== undefined &&
      expectedVersion !== this.historyVersion
    ) {
      console.log(
        `[BeaconManager] postExternalMessage skipped (history reset during background task: expected v${expectedVersion}, current v${this.historyVersion})`
      );
      return null;
    }
    const message: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date(),
    };
    if (this.session && this.session.activeTurnCount > 0) {
      // LLM が応答 streaming 中 (= activeTurnCount > 0) の場合、live emit と
      // DB 永続化を両方 defer する。即時 live emit すると「live UI: external
      // →assistant」「DB reload: assistant→external」と順序が食い違うため、
      // turn 完了後にまとめて行う。
      // ※ session.processing は session 生存期間中ずっと true のため判定に
      //   使えない。activeTurnCount が「現在進行中の turn 数」の正確な
      //   シグナル (multi-client で複数 turn が queue されていても安全)。
      this.pendingExternalMessages.push(message);
    } else {
      this.persistAndEmitExternal(message);
    }
    return message;
  }

  /**
   * 外部メッセージを DB / session.messages へ保存し、
   * `beacon:external-message` イベントで通知する。
   */
  private persistAndEmitExternal(message: ChatMessage): void {
    db.addBeaconMessage(message);
    if (this.session) {
      this.session.messages.push(message);
    }
    this.emit("beacon:external-message", message);
  }

  /**
   * postExternalMessage で待機中の外部メッセージを DB / session.messages に
   * 反映し、`beacon:external-message` を emit する。
   * LLM turn 完了時 / セッション close 時 / エラー時に呼び出す。
   *
   * 確実に assistantMessage より後で、互いも strict ordering になるよう
   * `Date.now() + 1` を起点に index 毎に +1ms ずらした timestamp を設定する。
   * (同一ミリ秒に着地して timestamp ソートが不安定になるのを回避)
   */
  private flushPendingExternalMessages(): void {
    if (this.pendingExternalMessages.length === 0) return;
    const queued = this.pendingExternalMessages;
    this.pendingExternalMessages = [];
    const baseMs = Date.now() + 1;
    queued.forEach((message, i) => {
      message.timestamp = new Date(baseMs + i);
      this.persistAndEmitExternal(message);
    });
  }

  /**
   * チャット履歴を取得する
   *
   * セッション未開始時はDBから直接ロードする（サーバー再起動・アイドルタイムアウト後も履歴を保持するため）
   */
  getHistory(): ChatMessage[] {
    if (this.session) return [...this.session.messages];
    return db.getBeaconMessages();
  }

  /**
   * チャット履歴を全削除する
   *
   * サーバー側のセッション（LLMコンテキスト）も閉じてDB履歴もクリアする。
   * 次のメッセージ送信時に新規セッションが開始される。
   *
   * 順序が重要:
   * 1. historyVersion を先に上げる
   *    → 進行中の /usage が postExternalMessage を呼んでも version mismatch
   *      で skip される。
   * 2. pendingExternalMessages を捨てる
   *    → closeSession 内の flushPendingExternalMessages が emit/persist しない
   *      ようにする (= cleared chat への stale message 復活を防ぐ)。
   * 3. closeSession (LLMコンテキスト中断、queue空なので flush は no-op)。
   * 4. DB クリア。
   */
  clearHistory(): void {
    this.historyVersion += 1;
    this.pendingExternalMessages = [];
    this.closeSession();
    db.clearBeaconMessages();
    console.log("[BeaconManager] 履歴をクリアしました");
  }

  /**
   * セッションが存在するか確認する
   */
  hasSession(): boolean {
    return this.session !== null;
  }

  /**
   * セッションを閉じてリソースを解放する
   */
  closeSession(): void {
    if (!this.session) return;

    console.log("[BeaconManager] セッション終了");

    // 滞留中の外部メッセージを必ず DB に確定させる
    // (idle close / clearHistory 経由でも消失しないように)
    this.flushPendingExternalMessages();

    // query()を中断する
    this.session.abortController.abort();
    // メッセージキューを閉じる
    this.session.queue.close();
    // セッションをクリア
    this.session = null;
  }

  /**
   * 全セッションを閉じてクリーンアップする
   */
  cleanup(): void {
    this.closeSession();
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    console.log("[BeaconManager] クリーンアップしました");
  }
}

/** シングルトンインスタンス */
export const beaconManager = new BeaconManager();
