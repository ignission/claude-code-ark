import { Check, Copy } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "@/lib/copy-text";

/** 結果表示を出しておく時間 (ms)。失敗は読む時間が要るので長めにする */
const COPIED_RESET_MS = 2000;
const FAILED_RESET_MS = 4000;

type CopyStatus = "idle" | "copied" | "failed";

/**
 * 会話ビューの fenced code block。右上のボタンで中身をコピーする。
 *
 * コピーするのは描画前の生テキスト (`code`) で、表示側の装飾
 * (ファイルパスのリンク化) は混ぜない。ボタンは pre の外に置くので、
 * 横スクロールするコードでも一緒に流れない。
 */
export function CodeBlock({
  code,
  children,
  ...preProps
}: { code: string } & ComponentProps<"pre">) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    const next: CopyStatus = (await copyTextToClipboard(code))
      ? "copied"
      : "failed";
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus(next);
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        setStatus("idle");
      },
      next === "copied" ? COPIED_RESET_MS : FAILED_RESET_MS
    );
  };

  return (
    <div className="ark-code-block relative">
      <pre {...preProps}>{children}</pre>
      <button
        type="button"
        aria-label="コードをコピー"
        onClick={handleCopy}
        className="ark-code-copy absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-sm border border-border bg-background/90 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {status === "copied" ? (
          <Check aria-hidden="true" className="size-3.5 text-primary" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      {status !== "idle" && (
        <p
          role="status"
          className={
            status === "copied" ? "sr-only" : "mt-1 text-destructive text-xs"
          }
        >
          {status === "copied" ? "コピーしました" : "コピーできませんでした"}
        </p>
      )}
    </div>
  );
}
