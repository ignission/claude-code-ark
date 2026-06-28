import { useEffect, useRef, useState } from "react";
import { renderMermaidToSvg } from "../lib/mermaid-block-utils";

let canvasSeq = 0;

/** 右ペインの「図解」キャンバスタブ。チャットの mermaid 図を大きく描画する。
 *  描画substrate は MermaidBlock と同じ renderMermaidToSvg を共用。
 *  インラインと違い max-width 制限を外し、natural サイズ + スクロールで表示する。 */
export function CanvasViewerPane({
  mermaidCode,
  title,
}: {
  mermaidCode: string;
  title?: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-canvas-${(canvasSeq += 1)}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await renderMermaidToSvg(mermaidCode, idRef.current);
      if (cancelled) return;
      if (result.ok) {
        setSvg(result.svg);
        setError(null);
      } else {
        setSvg(null);
        setError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaidCode]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="shrink-0 border-border border-b px-3 py-2 font-medium text-foreground text-sm">
        🎨 {title ?? "図解"}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {svg && !error ? (
          <div
            className="ark-canvas-svg flex justify-center [&_svg]:max-w-none"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict の出力のため安全
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div className="text-destructive text-sm">
            図の描画に失敗しました: {error}
            <pre className="mt-2 overflow-auto whitespace-pre rounded bg-muted p-3 font-mono text-foreground text-xs">
              {mermaidCode}
            </pre>
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">描画中…</div>
        )}
      </div>
    </div>
  );
}
