import { type RefObject, useEffect } from "react";

/**
 * ttyd iframe内のxterm.jsにリンク検出プロバイダーをインジェクトするカスタムフック。
 * TerminalPane.tsx と MobileSessionView.tsx で共通利用する。
 */
export function useTerminalLinkInjection(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  iframeKey: number
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: iframeKeyはiframeリロード時にリンクプロバイダーを再インジェクトするために必要
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let checkTermInterval: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const injectLinkProvider = () => {
      try {
        const iframeWindow = iframe.contentWindow;
        if (!iframeWindow) return;

        checkTermInterval = setInterval(() => {
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のxterm.jsオブジェクトにアクセスするため
          const term = (iframeWindow as any).term;
          if (!term?.registerLinkProvider) return;
          if (checkTermInterval) clearInterval(checkTermInterval);
          checkTermInterval = null;

          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内の状態管理フラグ
          if ((iframeWindow as any).__arkLinkInjected) return;
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内の状態管理フラグ
          (iframeWindow as any).__arkLinkInjected = true;

          // ttydのWebLinksAddonがlocalhost URLを新規タブで開くのを阻止する。
          // WebLinksAddonは初期化時にwindow.openの参照をキャプチャするため、
          // window.openのオーバーライドでは捕捉できない。
          // 代わりに、iframe document上でclickイベントをキャプチャフェーズで
          // インターセプトし、localhost URLへのリンククリックをpostMessageに変換する。
          const iframeDoc = iframeWindow.document;
          iframeDoc.addEventListener(
            "click",
            (e: MouseEvent) => {
              const anchor = (e.target as HTMLElement).closest?.("a");
              if (!anchor) return;
              const href = anchor.getAttribute("href") || "";
              if (
                /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(href)
              ) {
                e.preventDefault();
                e.stopPropagation();
                window.postMessage(
                  { type: "ark:open-url", url: href },
                  window.location.origin
                );
              }
            },
            true // キャプチャフェーズで先に処理
          );

          // window.openも念のためオーバーライド（一部環境でwindow.openが使われる場合）
          const origOpen = iframeWindow.open;
          iframeWindow.open = function (url?: string | URL, ...args: any[]) {
            const urlStr = String(url ?? "");
            if (
              /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(urlStr)
            ) {
              window.postMessage(
                { type: "ark:open-url", url: urlStr },
                window.location.origin
              );
              return null;
            }
            return origOpen.apply(iframeWindow, [url, ...args] as any);
          };

          term.registerLinkProvider({
            provideLinks(
              lineNumber: number,
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js link provider API
              callback: (links: any[] | undefined) => void
            ) {
              const line = term.buffer.active.getLine(lineNumber - 1);
              if (!line) {
                callback(undefined);
                return;
              }
              const text = line.translateToString();
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js link objects
              const links: any[] = [];

              // ファイルパス検出
              const fileRegex =
                /(?:file:)?([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+)(?::(\d+))?/g;
              let match: RegExpExecArray | null;
              while ((match = fileRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const filePath = match[1];
                const lineNum = match[2] ? Number.parseInt(match[2], 10) : null;
                if (!filePath.includes("/") && !fullMatch.startsWith("file:"))
                  continue;
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: {
                      x: match.index + fullMatch.length + 1,
                      y: lineNumber,
                    },
                  },
                  text: fullMatch,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-file", path: filePath, line: lineNum },
                      window.location.origin
                    );
                  },
                });
              }

              // localhost URL検出
              const urlRegex =
                /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[/\w.\-?&=%#]*/g;
              while ((match = urlRegex.exec(text)) !== null) {
                const matchedUrl = match[0];
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: {
                      x: match.index + matchedUrl.length + 1,
                      y: lineNumber,
                    },
                  },
                  text: matchedUrl,
                  activate() {
                    window.parent.postMessage(
                      { type: "ark:open-url", url: matchedUrl },
                      window.location.origin
                    );
                  },
                });
              }

              callback(links.length > 0 ? links : undefined);
            },
          });
        }, 500);

        timeoutId = setTimeout(() => {
          if (checkTermInterval) {
            clearInterval(checkTermInterval);
            checkTermInterval = null;
          }
        }, 10000);
      } catch {
        // クロスオリジンエラー等は無視
      }
    };

    iframe.addEventListener("load", injectLinkProvider);
    if (iframe.contentDocument?.readyState === "complete") {
      injectLinkProvider();
    }

    return () => {
      iframe.removeEventListener("load", injectLinkProvider);
      if (checkTermInterval) clearInterval(checkTermInterval);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [iframeRef, iframeKey]);
}
