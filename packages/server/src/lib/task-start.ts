/**
 * 新しいタスク: worktree を作り、セッションを起動し、起動を待って最初の文を送る。
 *
 * MCP の task_start (セッションの Claude が子タスクを起こす) と、Socket.IO の task:start
 * (人がサイドバー・モバイル・分岐TODOから起こす) の共通の実装。経路は人が手でやる
 * worktree:create → (自動起動) → session:send と同じものを順に呼ぶだけで、別の起動方法は持たない。
 *
 * ## 送ってよいかの判定 (waitForPromptReady)
 *
 * claude の起動コマンドを打った直後は、シェルのプロンプトとコマンドだけが画面にあり、
 * bridgeStatus は READY に倒れる。ここで送ると文がシェルに打ち込まれて実行される。
 * そのため次の 2 つが揃ったのを 2 回続けて見てから送る。2 回目は画面を取り直して、
 * 確認のメニューが出ていないことと入力欄の描画を待つためのもの (状態ファイルの読み取りは
 * 2 秒キャッシュされるので、続けた 2 回で同じ値になることがある)。
 *
 * - CLI の状態ファイルが書かれ、状態が idle (claude 本体が起動して入力待ち)
 * - bridgeStatus が READY か IDLE (画面に許諾や確認のメニューが出ていない)
 *
 * AWAITING (フォルダの信頼の確認など) が出ていたら送らない。答えるのは人なので、
 * タイムアウトまで待ち、送らずに返す。状態ファイルを読めない環境 (/proc の無い macOS)
 * では起動を確かめられないので、待たずに送らない。どちらの場合も worktree とセッションは
 * 消さない (起動したところまでは成功している。文は人か親の Claude が送り直せる)。
 *
 * ## 名前を省いたとき
 *
 * 人が新しいタスクのダイアログで名前を空にしたら、プロンプトの先頭の行から名前を作る (deriveTaskName)。
 * ブランチ名は英数字と . _ - / だけなので、英数字の語を拾い、無ければ (日本語だけのプロンプトなど)
 * `task-<月日>-<時分>` にする。同名のブランチがあると既存のブランチに付けて作業を引き継いでしまうので、
 * 空いている名前になるまで末尾に `-2`、`-3` を付ける。ブランチ名だけでは中身が分からないので、
 * プロンプトの先頭の行を worktree の表示名にする (deriveTaskTitle)。名前を渡したときは表示名を付けない。
 * 名前は機械で作る。claude に要約させない (Arkは `claude -p` を使わない)。
 *
 * ## 親子
 *
 * 親の worktree はセッションの行に記録するだけで、子の結果を親へ届ける仕組みは持たない
 * (Ark はセッションに会話の外の情報を注入しない。CLAUDE.md の「コンテキスト機構は持たない」)。
 * 親が子の今の状態を知りたければ、自分で task_list を呼ぶ。返すのは Ark の一覧に出ている値
 * (状態の区分、ブランチ、PR) だけで、子の会話の中身は返さない。
 *
 * ## 別のリポジトリへの切り出し
 *
 * task_start の repo を指定すると、呼び出し元と別のリポジトリに子を作る (解決は task-repo.ts)。
 * 1 つのセッションを入口にして、各リポジトリの仕事を切り出すためのもの。ベースは切り出し先の
 * リモートの既定ブランチの最新 (fetch してから origin/main などを使う。git.ts の getLatestDefaultBase)。画面は、別のリポジトリへ切り出した子のセッションを、
 * リポジトリが未登録でも一覧に出す (web の lib/child-task-repos.ts)。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import type { CliSessionState } from "./cli-session-status.js";
import { getErrorMessage } from "./errors.js";
import { m } from "./i18n.js";

export interface LaunchState {
  bridgeStatus: BridgeSessionStatus;
  cliState: CliSessionState | null;
  /** CLI の状態ファイルを読める環境か (Linux だけ) */
  cliRecordSupported: boolean;
}

export interface TaskStartDeps {
  /** worktree を作り、作ったことを全クライアントへ知らせる */
  createWorktree(
    repoPath: string,
    branchName: string,
    baseBranch: string | undefined
  ): Promise<Worktree>;
  startSession(
    worktree: Worktree,
    repoPath: string,
    parentWorktreePath: string | undefined
  ): Promise<ManagedSession>;
  /** セッションが無いか画面を取れなければ null */
  readLaunchState(sessionId: string): LaunchState | null;
  sendMessage(sessionId: string, message: string): void;
  /** 分岐TODOから起こしたとき、始めた先を記録する (失敗しても続ける) */
  recordTodoStarted?(todoId: string, worktreePath: string): void;
  /**
   * その名前で作るとまっさらなブランチになるか (同名のブランチも作成先も無い)。
   * 名前を省いたときに、空いている名前を選ぶのに使う
   */
  isNameAvailable(repoPath: string, name: string): Promise<boolean>;
  /** worktree の表示名を付ける (名前を省いたときだけ。失敗しても続ける) */
  setDisplayName?(worktreePath: string, displayName: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TaskStartInput {
  repoPath: string;
  /** 空ならプロンプトから作る */
  name?: string;
  prompt: string;
  /** 解決済みのベースブランチ。undefined なら git の HEAD */
  baseBranch?: string;
  parentWorktreePath?: string;
  todoId?: string;
}

export type PromptDelivery =
  | { sent: true }
  | { sent: false; reason: "awaiting" | "timeout" | "unsupported" | "gone" }
  | { sent: false; reason: "error"; error: string };

export interface TaskStarted {
  sessionId: string;
  worktreePath: string;
  branch: string;
  /** 起動を待って文を送り終えたら解決する (reject しない) */
  delivery: Promise<PromptDelivery>;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
}

export const DEFAULT_WAIT: WaitOptions = { timeoutMs: 60_000, intervalMs: 500 };

/** 1 回の観測で、送ってよい状態に見えるか */
export function looksReadyForPrompt(state: LaunchState): boolean {
  return (
    state.cliState === "idle" &&
    (state.bridgeStatus === "READY" || state.bridgeStatus === "IDLE")
  );
}

/**
 * 起動したばかりのセッションに文を送ってよくなるまで待つ。
 * 送ってよい状態を 2 回続けて見たら "ready"。
 */
export async function waitForPromptReady(
  deps: Pick<TaskStartDeps, "readLaunchState" | "sleep" | "now">,
  sessionId: string,
  options: WaitOptions = DEFAULT_WAIT
): Promise<"ready" | "awaiting" | "timeout" | "unsupported" | "gone"> {
  const deadline = deps.now() + options.timeoutMs;
  let readyStreak = 0;
  let lastWasAwaiting = false;
  let seen = false;
  while (deps.now() < deadline) {
    const state = deps.readLaunchState(sessionId);
    if (state) {
      seen = true;
      if (!state.cliRecordSupported) return "unsupported";
      lastWasAwaiting = state.bridgeStatus === "AWAITING";
      readyStreak = looksReadyForPrompt(state) ? readyStreak + 1 : 0;
      if (readyStreak >= 2) return "ready";
    } else if (seen) {
      // 一度は見えていたセッションが消えた (止められた)
      return "gone";
    }
    await deps.sleep(options.intervalMs);
  }
  return lastWasAwaiting ? "awaiting" : "timeout";
}

/**
 * タスク名とプロンプトを確かめる。タスク名はブランチ名になるので、空白はハイフンに寄せ
 * (作成ダイアログの入力と同じ)、git のブランチ名に使える文字だけを許す。名前は空でもよい
 * (startTask がプロンプトから作る)
 */
export function validateTaskInput(input: { name?: unknown; prompt: unknown }): {
  name: string;
  prompt: string;
} {
  const name =
    typeof input.name === "string"
      ? input.name.trim().replace(/\s+/g, "-")
      : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error(m().serverGit.task.promptEmpty);
  if (name && (!/^[a-zA-Z0-9._\-/]+$/.test(name) || name.startsWith("-"))) {
    throw new Error(m().serverGit.task.nameInvalid);
  }
  return { name, prompt };
}

/** 名前に使う語の数と長さの上限 */
const MAX_NAME_WORDS = 5;
const MAX_NAME_LENGTH = 40;
/** 表示名にするプロンプトの先頭の長さ */
const MAX_TITLE_LENGTH = 40;

function firstLine(prompt: string): string {
  return (
    prompt
      .split("\n")
      .map(line => line.trim())
      .find(line => line !== "") ?? ""
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * プロンプトの先頭の行からタスク名 (ブランチ名) を作る。英数字の語を小文字にしてハイフンでつなぎ、
 * 語が無ければ `task-<月日>-<時分>` (サーバーの時計) にする
 */
export function deriveTaskName(prompt: string, now: Date): string {
  const words = firstLine(prompt)
    // 全角の英数字を半角に寄せる
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== "");
  let name = "";
  for (const word of words.slice(0, MAX_NAME_WORDS)) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > MAX_NAME_LENGTH) break;
    name = next;
  }
  if (name) return name;
  return `task-${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

/** プロンプトの先頭の行を、worktree の表示名の長さに切る */
export function deriveTaskTitle(prompt: string): string {
  const line = firstLine(prompt).replace(/\s+/g, " ");
  const chars = Array.from(line);
  return chars.length > MAX_TITLE_LENGTH
    ? `${chars.slice(0, MAX_TITLE_LENGTH).join("")}…`
    : line;
}

/** 空いている名前の候補を試す回数 (`-2` から `-<この値>` まで) */
const MAX_NAME_SUFFIX = 50;

/** base が使われていれば `-2`、`-3` と末尾を変え、空いている名前を返す */
export async function pickAvailableName(
  deps: Pick<TaskStartDeps, "isNameAvailable">,
  repoPath: string,
  base: string
): Promise<string> {
  if (await deps.isNameAvailable(repoPath, base)) return base;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const candidate = `${base}-${n}`;
    if (await deps.isNameAvailable(repoPath, candidate)) return candidate;
  }
  throw new Error(m().serverGit.task.noAvailableName(base));
}

/**
 * worktree を作ってセッションを起動したところで返す。文の送信は delivery で待てる。
 * worktree の作成かセッションの起動に失敗したら throw する。
 */
export async function startTask(
  deps: TaskStartDeps,
  input: TaskStartInput,
  options: WaitOptions = DEFAULT_WAIT
): Promise<TaskStarted> {
  const validated = validateTaskInput(input);
  const { prompt } = validated;
  const autoNamed = validated.name === "";
  const name = autoNamed
    ? await pickAvailableName(
        deps,
        input.repoPath,
        deriveTaskName(prompt, new Date(deps.now()))
      )
    : validated.name;
  const worktree = await deps.createWorktree(
    input.repoPath,
    name,
    input.baseBranch
  );
  if (autoNamed) {
    try {
      deps.setDisplayName?.(worktree.path, deriveTaskTitle(prompt));
    } catch {
      // 表示名はおまけ。起動は続ける
    }
  }
  if (input.todoId) {
    try {
      deps.recordTodoStarted?.(input.todoId, worktree.path);
    } catch {
      // 始めた先の記録はおまけ。起動は続ける
    }
  }
  const session = await deps.startSession(
    worktree,
    input.repoPath,
    input.parentWorktreePath
  );

  const delivery = (async (): Promise<PromptDelivery> => {
    try {
      const ready = await waitForPromptReady(deps, session.id, options);
      if (ready !== "ready") return { sent: false, reason: ready };
      deps.sendMessage(session.id, prompt);
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: "error", error: getErrorMessage(error) };
    }
  })();

  return {
    sessionId: session.id,
    worktreePath: worktree.path,
    branch: worktree.branch,
    delivery,
  };
}

/** delivery の結果を、人と Claude に返す 1 文にする */
export function describeDelivery(delivery: PromptDelivery): string {
  if (delivery.sent) return m().serverGit.task.promptSent;
  switch (delivery.reason) {
    case "awaiting":
      return m().serverGit.task.notSentAwaiting;
    case "timeout":
      return m().serverGit.task.notSentTimeout;
    case "unsupported":
      return m().serverGit.task.notSentUnsupported;
    case "gone":
      return m().serverGit.task.notSentGone;
    case "error":
      return m().serverGit.task.sendFailed(delivery.error);
  }
}
