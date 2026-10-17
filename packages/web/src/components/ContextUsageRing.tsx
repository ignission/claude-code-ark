/**
 * コンテキストの使用量を、入力欄の横の小さなリングで出す。
 *
 * 深いセッションほど応答が劣化するので、切り直す (/clear か新しいセッション) 目安にする。
 * 割合の分母は推定 (`lib/context-usage.ts`)。正確な数は title に出す。
 * 80%を超えたら色を変える (auto-compactが近い)。
 */

import type { ContextUsage } from "@/lib/context-usage";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const HIGH_RATIO = 0.8;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function ContextUsageRing({ usage }: { usage: ContextUsage }) {
  const ratio = Math.min(usage.tokens / usage.window, 1);
  const percent = Math.round(ratio * 100);
  const high = ratio >= HIGH_RATIO;
  const label = `コンテキスト ${usage.tokens.toLocaleString()} / ${usage.window.toLocaleString()} トークン (${percent}%)。上限は推定`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="context-usage-ring"
      className={`inline-flex shrink-0 items-center gap-1 self-center text-[11px] tabular-nums ${
        high ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2.5"
        />
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
        />
      </svg>
      {formatTokens(usage.tokens)}
    </span>
  );
}
