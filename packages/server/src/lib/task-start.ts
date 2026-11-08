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
 * そのため次の 2 つが揃ったのを 2 回続けて見てから送る (2 回目は入力欄の描画待ち)。
 *
 * - CLI の状態ファイルが書かれ、状態が idle (claude 本体が起動して入力待ち)
 * - bridgeStatus が READY か IDLE (画面に許諾や確認のメニューが出ていない)
 *
 * AWAITING (フォルダの信頼の確認など) が出ていたら送らない。答えるのは人なので、
 * タイムアウトまで待ち、送らずに返す。状態ファイルを読めない環境 (/proc の無い macOS)
 * では起動を確かめられないので、待たずに送らない。どちらの場合も worktree とセッションは
 * 消さない (起動したところまでは成功している。文は人か親の Claude が送り直せる)。
 *
 * ## 親子
 *
 * 親の worktree はセッションの行に記録するだけで、子の結果を親へ戻す仕組みは持たない
 * (Ark はセッションに会話の外の情報を注入しない。CLAUDE.md の「コンテキスト機構は持たない」)。
 * 親が見るのは Ark の一覧。
 */

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import type { CliSessionState } from "./cli-session-status.js";
import { getErrorMessage } from "./errors.js";

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
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TaskStartInput {
  repoPath: string;
  name: string;
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
 * (作成ダイアログの入力と同じ)、git のブランチ名に使える文字だけを許す
 */
export function validateTaskInput(input: { name: unknown; prompt: unknown }): {
  name: string;
  prompt: string;
} {
  const name =
    typeof input.name === "string"
      ? input.name.trim().replace(/\s+/g, "-")
      : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!name) throw new Error("タスク名が空です");
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name) || name.startsWith("-")) {
    throw new Error(
      "タスク名は英数字と . _ - / だけで書いてください (ブランチ名になります)"
    );
  }
  if (!prompt) throw new Error("プロンプトが空です");
  return { name, prompt };
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
  const { name, prompt } = validateTaskInput(input);
  const worktree = await deps.createWorktree(
    input.repoPath,
    name,
    input.baseBranch
  );
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
  if (delivery.sent) return "最初の文を送りました";
  switch (delivery.reason) {
    case "awaiting":
      return "セッションが確認の応答を待っているため、最初の文を送っていません (セッションを開いて答えてから送ってください)";
    case "timeout":
      return "claude の起動を確かめられなかったため、最初の文を送っていません";
    case "unsupported":
      return "この環境では claude の起動を確かめられないため、最初の文を送っていません";
    case "gone":
      return "セッションが止められたため、最初の文を送っていません";
    case "error":
      return `最初の文の送信に失敗しました: ${delivery.error}`;
  }
}
