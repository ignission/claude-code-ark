/**
 * voice-diagnostic - 音声モード (iPhone) の診断イベントを、pm2 のログの1行に整える。
 *
 * 実機で「認識が拒否されたか」「自動でマイクを開けたか」「読み上げの onend が来たか」を、
 * ユーザーに報告してもらわずに確かめるためのもの。保存も配信もしない。
 * クライアントは認識した文や返答の本文を送らない (文字数だけ)。
 */

const MAX_SESSION_ID = 64;
const MAX_KIND = 40;
const MAX_DETAIL = 200;

function clean(value: string, max: number): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, max);
}

export function formatVoiceDiagnostic(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { sessionId?: unknown; kind?: unknown; detail?: unknown };
  if (typeof d.sessionId !== "string" || typeof d.kind !== "string") {
    return null;
  }
  const detail =
    typeof d.detail === "string" ? clean(d.detail, MAX_DETAIL) : "";
  const head = `[Voice] session=${clean(d.sessionId, MAX_SESSION_ID)} ${clean(d.kind, MAX_KIND)}`;
  return detail ? `${head} ${detail}` : head;
}
