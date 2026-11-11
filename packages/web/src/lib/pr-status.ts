/**
 * セッションのPRとチェックの状態 (サーバーの `pr-status-collector.ts` が読む) を、
 * クライアントで持ち、一覧の行の札にする。
 */

import type { SessionPrStatus } from "@ark/shared";
import { m } from "./i18n";

function sameStatus(a: SessionPrStatus, b: SessionPrStatus): boolean {
  return (
    a.number === b.number &&
    a.url === b.url &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.checks === b.checks &&
    a.headRefOid === b.headRefOid
  );
}

/**
 * previews の prStatus を Map に反映する。変わらなければ prev をそのまま返す
 * (previews は毎秒届くので、一覧を毎秒描き直さない)。
 * previews に無いセッション (画面を取れなかった回) は前の値を残す
 */
export function mergePrStatuses(
  prev: ReadonlyMap<string, SessionPrStatus>,
  previews: ReadonlyArray<{
    sessionId: string;
    prStatus?: SessionPrStatus | null;
  }>
): Map<string, SessionPrStatus> {
  let next: Map<string, SessionPrStatus> | null = null;
  for (const { sessionId, prStatus } of previews) {
    const current = prev.get(sessionId);
    if (prStatus) {
      if (current && sameStatus(current, prStatus)) continue;
      next ??= new Map(prev);
      next.set(sessionId, prStatus);
    } else if (current) {
      next ??= new Map(prev);
      next.delete(sessionId);
    }
  }
  return next ?? (prev as Map<string, SessionPrStatus>);
}

export type PrBadgeTone = "ok" | "ng" | "wait" | "muted";

export interface PrBadge {
  /** 札の文字 (`#550 ✓` など) */
  text: string;
  /** title と読み上げに使う説明 */
  label: string;
  tone: PrBadgeTone;
}

/** 一覧の行に出す札。マージ済み・クローズはチェックより先に出す */
export function prBadge(status: SessionPrStatus): PrBadge {
  const pr = `#${status.number}`;
  if (status.state === "MERGED") {
    return {
      text: m.session.pr.mergedText(pr),
      label: m.session.pr.mergedLabel(pr),
      tone: "muted",
    };
  }
  if (status.state === "CLOSED") {
    return {
      text: m.session.pr.closedText(pr),
      label: m.session.pr.closedLabel(pr),
      tone: "muted",
    };
  }
  switch (status.checks) {
    case "failed":
      return {
        text: `${pr} ✕`,
        label: m.session.pr.checksFailedLabel(pr, status.isDraft),
        tone: "ng",
      };
    case "pending":
      return {
        text: m.session.pr.pendingText(pr),
        label: m.session.pr.checksPendingLabel(pr, status.isDraft),
        tone: "wait",
      };
    case "passed":
      return {
        text: `${pr} ✓`,
        label: m.session.pr.checksPassedLabel(pr, status.isDraft),
        tone: "ok",
      };
    case "none":
      return {
        text: pr,
        label: m.session.pr.noChecksLabel(pr, status.isDraft),
        tone: "muted",
      };
  }
}
