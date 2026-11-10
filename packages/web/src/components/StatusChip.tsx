import {
  CircleAlert,
  CircleHelp,
  CircleMinus,
  MessageSquare,
  Minus,
  Play,
} from "lucide-react";
import {
  presentStatus,
  type StatusIcon,
  type StatusKey,
  TONE_CLASSES,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";

interface StatusChipProps {
  statusKey: StatusKey;
  className?: string;
  /**
   * 文言の span にだけ当てる class。狭いときアイコンだけにするために、
   * 呼び出し側から `sr-only` 相当を渡す。読み上げからは消さないので
   * `hidden` (display:none) は渡さないこと
   */
  labelClassName?: string;
  /**
   * true なら地の塗りと枠を付けず、アイコン (と文言) を状態の色で出すだけにする。
   * 一覧の行のように、見出しが状態を言っていて、行には目印だけが要る場所で使う
   */
  bare?: boolean;
}

/** セッションの状態を「アイコン + 文言」のチップで出す。色だけに頼らない */
export function StatusChip({
  statusKey,
  className,
  labelClassName,
  bare = false,
}: StatusChipProps) {
  const p = presentStatus(statusKey);

  if (p.label === "") {
    return (
      <span
        data-status={statusKey}
        aria-hidden="true"
        className={cn(
          "inline-block size-2 shrink-0 rounded-full bg-status-neutral/40",
          className
        )}
      />
    );
  }

  const tone = TONE_CLASSES[p.tone];
  return (
    <span
      data-status={statusKey}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-[12px] font-semibold leading-none",
        bare
          ? p.outlined
            ? "text-muted-foreground"
            : tone.text
          : p.outlined
            ? "border border-border text-muted-foreground"
            : [tone.softBg, tone.text],
        className
      )}
    >
      <StatusGlyph icon={p.icon} />
      <span className={labelClassName}>{p.label}</span>
    </span>
  );
}

function StatusGlyph({ icon }: { icon: StatusIcon }) {
  const svg = "size-3 shrink-0";
  switch (icon) {
    case "dots":
      return (
        <span className="status-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      );
    case "question":
      return <CircleHelp className={svg} aria-hidden="true" />;
    case "alert":
      return <CircleAlert className={svg} aria-hidden="true" />;
    case "message":
      return <MessageSquare className={svg} aria-hidden="true" />;
    case "minus":
      return <Minus className={svg} aria-hidden="true" />;
    case "stop":
      return <CircleMinus className={svg} aria-hidden="true" />;
    case "play":
      return <Play className={svg} aria-hidden="true" />;
  }
}
