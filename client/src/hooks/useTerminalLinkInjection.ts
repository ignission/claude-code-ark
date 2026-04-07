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

        // 既存のinterval/timeoutをクリア（重複防止）
        if (checkTermInterval) {
          clearInterval(checkTermInterval);
          checkTermInterval = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

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

          // xterm.js WebLinksAddonのlocalhost URLを横取りする。
          // WebLinksAddonは window.open() を引数なしで呼び、返されたウィンドウの
          // location.href にURLを設定するパターン:
          //   const newWindow = window.open();
          //   newWindow.opener = null;
          //   newWindow.location.href = uri;
          // そのため、フェイクWindowオブジェクトを返してlocation.hrefのセッターで
          // localhost URLを検出し、postMessageに変換する。
          const arkWindow = window;
          const origOpen = iframeWindow.open.bind(iframeWindow);
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のwindow.openをオーバーライドするため型を緩める
          (iframeWindow as any).open = (
            url?: string | URL,
            target?: string,
            features?: string
          ): Window | null => {
            // 引数ありの呼び出し（URL直接指定）
            if (url) {
              const urlStr = String(url);
              if (
                /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(urlStr)
              ) {
                arkWindow.postMessage(
                  { type: "ark:open-url", url: urlStr },
                  arkWindow.location.origin
                );
                return null;
              }
              return origOpen(url, target, features);
            }

            // 引数なしの呼び出し（WebLinksAddonパターン）
            // フェイクWindowを返し、location.hrefセッターでURLを横取り
            const fakeWindow = {
              opener: null,
              location: {
                _href: "",
                set href(u: string) {
                  if (
                    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(u)
                  ) {
                    arkWindow.postMessage(
                      { type: "ark:open-url", url: u },
                      arkWindow.location.origin
                    );
                  } else {
                    // localhost以外は実際に新しいウィンドウで開く
                    const real = origOpen();
                    if (real) {
                      try {
                        real.opener = null;
                      } catch {}
                      real.location.href = u;
                    }
                  }
                },
                get href() {
                  return this._href;
                },
              },
              close() {},
            };
            // biome-ignore lint/suspicious/noExplicitAny: xterm.js WebLinksAddonが期待するwindowのサブセットのみ実装
            return fakeWindow as any;
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
                    arkWindow.postMessage(
                      { type: "ark:open-file", path: filePath, line: lineNum },
                      arkWindow.location.origin
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
                    arkWindow.postMessage(
                      { type: "ark:open-url", url: matchedUrl },
                      arkWindow.location.origin
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
