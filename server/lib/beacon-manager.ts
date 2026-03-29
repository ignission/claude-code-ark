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

### 「タスク着手」

ユーザーが思いついたタスクを壁打ちし、Issue/チケットを作成してからworktreeで着手させるフロー。

#### Phase 1: 壁打ち
1. list_repositoriesで全リポジトリ一覧を取得
2. 番号付きリストでリポジトリを提示し、ユーザーに選ばせる
3. ユーザーがリポジトリを選択したら、タスクの内容をヒアリング
   - 「どんなタスクですか？」と聞く
   - ユーザーの説明を深掘り・整理する（目的、スコープ、受入条件など）
   - 壁打ちが十分と判断したら「この内容でIssue/チケットを作成しますか？」と要約を提示

#### Phase 2: Issue/チケット作成（mainセッション経由）
4. 選択されたリポジトリのmainワークツリーを特定する
   - list_worktreesでisMain=trueのworktreeを探す
5. mainのセッションを確認・起動する
   - list_sessionsで既存セッションを確認。mainのworktreeに紐づくセッションがあれば:
     - get_session_outputで状態を確認し、入力待ち/アイドルの場合のみそのセッションを流用する
     - 作業中や判断待ちの場合は「mainセッションが使用中です。中断してよいですか？」とユーザーに確認する
   - セッションがなければstart_sessionでmainのセッションを起動
6. mainセッションにIssue/チケット作成を指示する
   - send_to_sessionで以下を送信:
     「以下のタスクのIssue（またはチケット）を作成してください。作成先はプロジェクトの設定に従ってください。\n\nタスク内容:\n{壁打ちで整理した要約}\n\n作成したIssue/チケットの識別子（例: #123 や PROJ-123）とURLを教えてください。」
7. mainセッションの出力を監視する
   - get_session_outputを数回ポーリングし、Issue/チケットの識別子とURLを検出する
   - 見つかったらユーザーに報告: 「{識別子} を作成しました」

#### Phase 3: worktree作成＆タスク着手
8. Issue/チケットの識別子からブランチ名を構築する
   - GitHub Issue: feat/123-slug（例: feat/123-add-search）
   - Jira: feat/PROJ-123-slug（例: feat/PMDEV-325-supplier-password）
   - ユーザーに確認: 「このブランチ名でよいですか？」
9. 確認が取れたら:
   - create_worktreeでworktreeを作成（返り値にworktreeのIDとパスが含まれる）
   - start_sessionでセッションを起動（create_worktreeの返り値のidとpathを使う）
   - send_to_sessionでタスク内容 + Issue/チケットURLをClaude Codeに入力
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
  /** 出力処理が進行中かどうか */
  processing: boolean;
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
  stopSession: (sessionId: string) => void;
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
              "scroll-up",
              "scroll-down",
              "copy-mode",
              "q",
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
        ],
        permissionMode: "default",
        systemPrompt: BEACON_SYSTEM_PROMPT,
        maxTurns: 50,
        abortController,
        ...(mcpServers ? { mcpServers } : {}),
      },
    });

    const session: BeaconSession = {
      queue,
      outputIterator: q[Symbol.asyncIterator](),
      queryInstance: q,
      messages: [],
      lastActivity: new Date(),
      processing: false,
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
    this.emit("beacon:message", userMessage);

    // キューにメッセージをpush（query()のAsyncIterableに供給される）
    session.queue.push(message);

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
          if (assistantText) {
            const assistantMessage: ChatMessage = {
              id: randomUUID(),
              role: "assistant",
              content: assistantText,
              timestamp: new Date(),
              toolUse: lastToolUse,
            };
            session.messages.push(assistantMessage);
            this.emit("beacon:message", assistantMessage);
          }

          // 完了チャンクを送信
          const doneChunk: BeaconStreamChunk = {
            chunk: "",
            done: true,
          };
          this.emit("beacon:stream", doneChunk);

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
      }
    }
  }

  /**
   * チャット履歴を取得する
   */
  getHistory(): ChatMessage[] {
    return this.session ? [...this.session.messages] : [];
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
