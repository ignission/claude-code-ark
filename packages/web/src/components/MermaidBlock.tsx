import { useEffect, useRef, useState } from "react";
import { renderMermaidToSvg } from "../lib/mermaid-block-utils";

let seq = 0;

/** transcript の ```mermaid ブロックを SVG に描画する。
 *  ストリーミング中の未完成コードは 300ms デバウンス + エラーフォールバックで吸収する。 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${(seq += 1)}`);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      const result = await renderMermaidToSvg(code, idRef.current);
      if (cancelled) return;
      if (result.ok) {
        setSvg(result.svg);
        setError(null);
      } else {
        setSvg(null);
        setError(result.error);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [code]);

  if (svg === null || error) {
    // 未描画 or 構文エラー: 生コードにフォールバック（pre-in-pre を避け div で表示）
    return (
      <div className="ark-mermaid-fallback my-2 overflow-x-auto whitespace-pre rounded bg-muted p-3 font-mono text-sm">
        {code}
        {error && (
          <span className="mt-1 block font-sans text-destructive text-xs">
            図の描画に失敗しました: {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="ark-mermaid my-2">
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={() =>
            window.postMessage(
              { type: "ark:open-canvas", code, title: "会話の図" },
              window.location.origin
            )
          }
          className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
          title="この図を右ペインのキャンバスで開く"
        >
          ⤢ キャンバスで開く
        </button>
      </div>
      <div
        className="flex justify-center overflow-x-auto"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict の出力のため安全
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
