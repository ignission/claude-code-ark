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

          // モバイル判定（touchイベント対応デバイスのみ）
          const isMobile =
            "ontouchstart" in iframeWindow ||
            iframeWindow.navigator.maxTouchPoints > 0;

          if (isMobile) {
            // モバイルでターミナルタップ時の仮想キーボードを防止
            // 入力は専用の入力バーで行うため、xterm.jsの入力用textareaは不要
            const xtermTextarea = iframeWindow.document.querySelector(
              ".xterm-helper-textarea"
            );
            if (xtermTextarea) {
              (xtermTextarea as HTMLTextAreaElement).setAttribute(
                "inputmode",
                "none"
              );
            }
          }

          // URL拡張マップ: 折り返しで切れた1行目URL → 複数行結合後の完全URL
          // provideLinksで構築し、fakeWindowのURL横取り処理で参照する。
          // WebLinksAddonが優先的にactivateされても、ここで完全URLに復元できる。
          const urlExtensionMap = new Map<string, string>();

          // registerLinkProviderのactivateで処理済みのURLを記録するSet。
          // window.openオーバーライド側でこのSetに含まれるURLをスキップすることで、
          // WebLinksAddonとregisterLinkProviderの二重発火を防止する。
          // setTimeout(, 0)でマイクロタスク後にクリアするため、同一クリックイベント内でのみ有効。
          const handledUrls = new Set<string>();

          // xterm.js WebLinksAddonのURLを横取りする。
          // WebLinksAddonは window.open() を引数なしで呼び、返されたウィンドウの
          // location.href にURLを設定するパターン:
          //   const newWindow = window.open();
          //   newWindow.opener = null;
          //   newWindow.location.href = uri;
          // そのため、フェイクWindowオブジェクトを返してlocation.hrefのセッターで
          // URLを検出し、postMessageに変換する。
          const arkWindow = window;
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のwindow.openをオーバーライドするため型を緩める
          (iframeWindow as any).open = (
            url?: string | URL,
            target?: string,
            features?: string
          ): Window | null => {
            // 引数ありの呼び出し（URL直接指定）
            // registerLinkProviderで処理済みのURLはスキップ（二重タブ防止）
            if (url) {
              const urlStr = urlExtensionMap.get(String(url)) || String(url);
              if (handledUrls.has(urlStr)) return null;
              arkWindow.postMessage(
                { type: "ark:open-url", url: urlStr },
                arkWindow.location.origin
              );
              return null;
            }

            // 引数なしの呼び出し（WebLinksAddonパターン）
            // フェイクWindowを返し、location.hrefセッターでURLを横取り
            const fakeWindow = {
              opener: null,
              location: {
                _href: "",
                set href(u: string) {
                  // registerLinkProviderで処理済みのURLはスキップ（二重タブ防止）
                  const resolved = urlExtensionMap.get(u) || u;
                  if (handledUrls.has(resolved)) return;
                  arkWindow.postMessage(
                    { type: "ark:open-url", url: resolved },
                    arkWindow.location.origin
                  );
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

          // モバイルスワイプスクロール
          // iframe内のtouchイベントを検知し、postMessageで親ウィンドウに通知する。
          // 親側でSocket.IO経由のtmux copy-modeスクロールに変換する。
          // オーバーレイ不要のため、リンクタップもそのまま動作する。
          if (isMobile) {
            const iframeDoc = iframeWindow.document;
            let touchStartY = 0;
            let touchSentLines = 0;
            let isSwiping = false;
            const SWIPE_LINE_HEIGHT = 8; // 8pxで1行スクロール（高感度）
            const SWIPE_THRESHOLD = 3;

            // parentOriginの取得（修正5で定義済み）
            let parentOrigin = "*";
            try {
              parentOrigin = iframeWindow.parent.location.origin;
            } catch {
              // cross-originの場合はフォールバック
            }

            iframeDoc.addEventListener(
              "touchstart",
              (e: Event) => {
                const te = e as TouchEvent;
                touchStartY = te.touches[0].clientY;
                touchSentLines = 0;
                isSwiping = false;
              },
              { capture: true, passive: true }
            );

            iframeDoc.addEventListener(
              "touchmove",
              (e: Event) => {
                const te = e as TouchEvent;
                const deltaY = touchStartY - te.touches[0].clientY;

                if (!isSwiping && Math.abs(deltaY) > SWIPE_THRESHOLD) {
                  isSwiping = true;
                }
                if (!isSwiping) return;

                e.preventDefault();

                const totalLines = Math.floor(
                  Math.abs(deltaY) / SWIPE_LINE_HEIGHT
                );
                const newLines = totalLines - touchSentLines;
                if (newLines > 0) {
                  const direction = deltaY > 0 ? "up" : "down";
                  iframeWindow.parent.postMessage(
                    { type: "ark:scroll", direction, lines: newLines },
                    parentOrigin
                  );
                  touchSentLines = totalLines;
                }
              },
              { capture: true, passive: false }
            );

            iframeDoc.addEventListener(
              "touchend",
              () => {
                touchSentLines = 0;
                isSwiping = false;
              },
              { capture: true, passive: true }
            );
          }

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
              const text = line.translateToString(true);
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js link objects
              const links: any[] = [];
              let match: RegExpExecArray | null;

              // ファイルパス検出
              // 1. file:プレフィックス付き（拡張子不問）: file:Dockerfile, file:src/main.rs:42
              // 2. パス区切り+拡張子付き: src/App.tsx:10
              const fileRegex =
                /(?:file:([a-zA-Z0-9_.\-/]+)|([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+))(?::(\d+))?/g;
              while ((match = fileRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const filePath = match[1] || match[2];
                const lineNum = match[3] ? Number.parseInt(match[3], 10) : null;
                if (!filePath) continue;
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

              // URL検出 + 複数行にまたがるURL延長
              // Claude Codeは長いURLを折り返す際、次行の先頭に空白を入れる。
              // URLの直後が行末（空白のみ）の場合、次行以降を先頭空白除去して結合する。
              // Mapサイズ上限（メモリリーク防止。clearはprovideLinksが行ごとに
              // 呼ばれるためクリック時にマッピングが消失する問題がある）
              if (urlExtensionMap.size > 100) {
                const firstKey = urlExtensionMap.keys().next().value;
                if (firstKey !== undefined) urlExtensionMap.delete(firstKey);
              }

              const urlRegex = /https?:\/\/[^\s<>"'()]+/g;
              while ((match = urlRegex.exec(text)) !== null) {
                let matchedUrl = match[0];
                const originalUrl = match[0];
                let endY = lineNumber;
                let endX = match.index + matchedUrl.length + 1;

                // URLの直後から行末まで空白のみか確認（URLが行の最後のトークン）
                const afterUrl = text.substring(
                  match.index + matchedUrl.length
                );
                if (/^\s*$/.test(afterUrl)) {
                  // 次行以降からURL継続部分を取得（最大10行まで）
                  const maxExtensionLines = 10;
                  for (
                    let nextIdx = lineNumber;
                    nextIdx < lineNumber + maxExtensionLines;
                    nextIdx++
                  ) {
                    const nextLine = term.buffer.active.getLine(nextIdx);
                    if (!nextLine) break;
                    const nextText = nextLine.translateToString(true);

                    if (nextLine.isWrapped) {
                      // ターミナル幅での自動折り返し（ハードラップ）:
                      // 前行からの続きが確定しているため、URL文字を結合する
                      const contMatch = nextText.match(/^[^\s<>"'()]+/);
                      if (!contMatch) break;
                      matchedUrl += contMatch[0];
                      endY = nextIdx + 1;
                      endX = contMatch[0].length + 1;
                      // URL継続部分の直後に他のテキストがあれば、ここでURLは終了
                      const afterCont = nextText.substring(contMatch[0].length);
                      if (!/^\s*$/.test(afterCont)) break;
                      continue;
                    }

                    // Claude Codeによる明示的改行（ソフトラップ）:
                    // 先頭空白 + URL文字で継続を判定
                    const trimmedNext = nextText.trimStart();
                    if (trimmedNext.length === 0) break;
                    const contMatch = trimmedNext.match(/^[^\s<>"'()]+/);
                    if (!contMatch) break;

                    // 継続部分の直後が行末でなければ、この行はURL継続ではない
                    const leadingSpaces = nextText.length - trimmedNext.length;
                    const afterCont = nextText.substring(
                      leadingSpaces + contMatch[0].length
                    );
                    if (!/^\s*$/.test(afterCont)) break;

                    matchedUrl += contMatch[0];
                    endY = nextIdx + 1;
                    endX = leadingSpaces + contMatch[0].length + 1;
                  }
                }

                // 末尾の句読点を除去（文中のURL: "See https://example.com." 等）
                const beforeTrim = matchedUrl.length;
                matchedUrl = matchedUrl.replace(/[.,;:!?]+$/, "");
                const trimmed = beforeTrim - matchedUrl.length;
                if (trimmed > 0) {
                  endX -= trimmed;
                }

                // 拡張された場合、元URL→完全URLの対応をMapに記録
                // WebLinksAddonが優先activateされた場合にfakeWindowで復元する
                if (matchedUrl !== originalUrl) {
                  urlExtensionMap.set(originalUrl, matchedUrl);
                }

                const finalUrl = matchedUrl;
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: { x: endX, y: endY },
                  },
                  text: finalUrl,
                  activate() {
                    // 処理済みURLとして記録し、WebLinksAddonのwindow.open側をスキップさせる
                    handledUrls.add(finalUrl);
                    setTimeout(() => handledUrls.delete(finalUrl), 0);
                    arkWindow.postMessage(
                      { type: "ark:open-url", url: finalUrl },
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
