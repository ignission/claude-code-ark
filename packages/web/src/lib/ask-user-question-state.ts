/**
 * ask-user-question-state - AskUserQuestion の JSONL ベース状態抽出と
 * tmux キー送出列の構築 (純粋関数)。
 *
 * 設計原則 (チャット UI v3): 質問・選択肢・回答状態はすべて JSONL の
 * tool_use / tool_result から得る。tmux 画面のパースは行わない。
 * 「回答待ち」= tool_use に対応する tool_result が未出現 (status: "running")。
 *
 * キー操作列は 2026-06-10 の実機スパイクで確定した挙動に基づく:
 *  - 単問 single-select: digit 一発で即 submit (Enter 不要・Review 無し)
 *  - multiSelect: digit = トグル。submit は Right → Review 画面 → digit 1
 *  - 複数質問: single 回答 (digit) で自動的に次タブへ。全問回答後は必ず
 *    Review 画面が出るので digit 1 (Submit answers) が必要
 *  - Review 画面が出る条件 = 質問が複数 or multiSelect を含む
 *  - 自由入力 "Type something." = options.length+1 にフォーカス (digit) →
 *    literal 一括送信 → Enter で確定
 *  - Escape は一発で全体 decline
 */

import type { JsonlParsedEvent, ToolCallEvent } from "./jsonl-event-parser";

export interface AuqOption {
  label: string;
  description?: string;
}

export interface AuqQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AuqOption[];
}

/** 回答待ちの AskUserQuestion (アクティブカードの描画対象) */
export interface ActiveAuq {
  toolUseId: string;
  questions: AuqQuestion[];
}

/** ユーザーが UI 上で選んだ回答 (キー送出列の入力) */
export type AuqAnswer =
  | { kind: "options"; indexes: number[] } // 0-based。single なら 1 要素
  | { kind: "free"; text: string };

/** キー送出ステップ。UI 層が順番に dispatch する */
export type AuqKeyStep =
  | { kind: "digit"; value: string } // session:key (1-9)
  | { kind: "key"; value: "Right" | "Enter" } // session:key
  | { kind: "literal"; value: string } // session:send-literal
  | { kind: "wait"; ms: number };

/** input.questions を型ガードしつつ正規化する。形が想定外なら null */
export function parseAuqInput(
  input: Record<string, unknown>
): AuqQuestion[] | null {
  const qs = input.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AuqQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") return null;
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== "string") return null;
    const optsRaw = rec.options;
    if (!Array.isArray(optsRaw)) return null;
    const options: AuqOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") return null;
      const oRec = o as Record<string, unknown>;
      if (typeof oRec.label !== "string") return null;
      options.push({
        label: oRec.label,
        description:
          typeof oRec.description === "string" ? oRec.description : undefined,
      });
    }
    out.push({
      question: rec.question,
      header: typeof rec.header === "string" ? rec.header : undefined,
      multiSelect: rec.multiSelect === true,
      options,
    });
  }
  return out;
}

/**
 * events 内に「at (epoch ms) 以降に解決された AskUserQuestion」があるか。
 *
 * 対話版 claude は AUQ の tool_use を「回答/拒否が確定した瞬間」に
 * tool_result とまとめて JSONL へ書く (= 質問表示中は JSONL に何も出ない)。
 * そのため回答待ちカードの表示開始は PreToolUse hook (session:auq) が担い、
 * この関数は「カードを閉じてよいか」(解決イベントが書かれたか) の判定に使う。
 *
 * timestamp は tool_use レコードの書き込み時刻 = 回答確定時刻なので、
 * hook 受信時刻 at より必ず後になる (同一ホストなのでクロックずれは数 ms)。
 * 5 秒のマージンは「直前の別 AUQ の解決」を誤検知しない範囲の安全幅。
 */
export function hasResolvedAuqSince(
  events: JsonlParsedEvent[],
  at: number
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "tool-call") continue;
    if (ev.tool !== "AskUserQuestion") continue;
    if (ev.isSidechain === true) continue;
    const tc = ev as ToolCallEvent;
    if (tc.status !== "done") continue;
    if (tc.timestamp !== undefined && tc.timestamp >= at - 5000) return true;
    // これより古いイベントしか無いので打ち切り
    return false;
  }
  return false;
}

/** Review 画面 (Submit answers 確認) が出るか。実機検証に基づく条件 */
export function needsReview(questions: AuqQuestion[]): boolean {
  return questions.length > 1 || questions.some(q => q.multiSelect);
}

/** 自由入力 "Type something." の TUI 上の番号 (1-based) */
export function freeTextDigit(q: AuqQuestion): number {
  return q.options.length + 1;
}

/**
 * 回答列からキー送出ステップ列を構築する。
 * answers は questions と同じ長さ・同じ順序であること。
 *
 * 制約: TUI の digit ジャンプは 1〜9 のみ。選択肢が 9 個を超えるケースや
 * freeTextDigit が 10 以上になるケースは null を返す (UI 側でターミナル
 * 誘導にフォールバックする)。
 */
export function buildKeySequence(
  questions: AuqQuestion[],
  answers: AuqAnswer[]
): AuqKeyStep[] | null {
  if (questions.length !== answers.length) return null;
  const steps: AuqKeyStep[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    if (a.kind === "free") {
      const digit = freeTextDigit(q);
      if (digit > 9) return null;
      // digit でフォーカス → テキスト一括 literal → Enter で確定
      // (確定は single 回答と同じセマンティクスで自動的に次タブへ進む)
      steps.push({ kind: "digit", value: String(digit) });
      steps.push({ kind: "wait", ms: 300 });
      steps.push({ kind: "literal", value: a.text });
      steps.push({ kind: "wait", ms: 200 });
      steps.push({ kind: "key", value: "Enter" });
      steps.push({ kind: "wait", ms: 300 });
    } else if (q.multiSelect) {
      if (a.indexes.length === 0) return null;
      for (const idx of a.indexes) {
        // 範囲外 index (負数含む) は SpecialKey 型外の digit ("0" 等) を
        // 生成し得るため明示的に拒否する
        if (idx < 0 || idx >= q.options.length) return null;
        if (idx + 1 > 9) return null;
        steps.push({ kind: "digit", value: String(idx + 1) });
        steps.push({ kind: "wait", ms: 150 });
      }
      // multiSelect はトグルだけでは次に進まないので Right でタブ送り
      // (最後の質問なら Review 画面へ進む)
      steps.push({ kind: "key", value: "Right" });
      steps.push({ kind: "wait", ms: 300 });
    } else {
      if (a.indexes.length !== 1) return null;
      const idx = a.indexes[0];
      if (idx < 0 || idx >= q.options.length) return null;
      if (idx + 1 > 9) return null;
      // single-select は digit 一発で回答確定 + 自動タブ送り
      // (単問の場合はこれだけで即 submit される)
      steps.push({ kind: "digit", value: String(idx + 1) });
      steps.push({ kind: "wait", ms: 300 });
    }
  }
  if (needsReview(questions)) {
    // Review 画面 (1. Submit answers / 2. Cancel) を digit 1 で確定
    steps.push({ kind: "wait", ms: 200 });
    steps.push({ kind: "digit", value: "1" });
  }
  return steps;
}
