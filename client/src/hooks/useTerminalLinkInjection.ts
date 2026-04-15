import { type RefObject, useEffect } from "react";

/**
 * ttyd iframe内のxterm.jsにリンク検出プロバイダーをインジェクトするカスタムフック。
 * TerminalPane.tsx と MobileSessionView.tsx で共通利用する。
 *
 * ## URLクリック制御の仕組み
 *
 * xterm.js の WebLinksAddon/OscLinkProvider が URL クリックを検出し activate を呼ぶ。
 * activate 内で window.open() → location.href = url のパターンで新タブを開く。
 * しかしブラウザ拡張機能がクリックイベントを検知して追加のタブを開くため、
 * 2タブ開く問題が発生していた。
 *
 * 対策: capture phase で mouseup/click を先取りし、リンクhover中であれば
 * stopImmediatePropagation で xterm.js および拡張機能にイベントを渡さない。
 * URL は term._core._linkifier2._currentLink から抽出し、
 * postMessage 経由で親ウィンドウに1回だけ開かせる。
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

          const isMobile =
            "ontouchstart" in iframeWindow ||
            iframeWindow.navigator.maxTouchPoints > 0;

          if (isMobile) {
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
          const urlExtensionMap = new Map<string, string>();

          const isLoopbackUrl = (urlStr: string): boolean => {
            try {
              const { protocol, hostname } = new URL(urlStr);
              return (
                (protocol === "http:" || protocol === "https:") &&
                (hostname === "localhost" || hostname === "127.0.0.1")
              );
            } catch {
              return false;
            }
          };

          const arkWindow = window;

          // 500ms dedup
          let lastOpenTime = 0;
          const tryClaimOpen = (): boolean => {
            const now = Date.now();
            if (now - lastOpenTime < 500) return false;
            lastOpenTime = now;
            return true;
          };

          /** URL を親ウィンドウ経由で開く */
          const openUrl = (rawUrl: string): void => {
            const resolved = urlExtensionMap.get(rawUrl) || rawUrl;
            if (!tryClaimOpen()) return;
            if (isLoopbackUrl(resolved)) {
              // localhost URL は postMessage 経由（リモートモードでは埋め込みブラウザに表示）
              arkWindow.postMessage(
                { type: "ark:open-url", url: resolved },
                arkWindow.location.origin
              );
            } else {
              // 非localhost URL は常に新タブで直接開く（リモートモードでもハイジャックしない）
              const a = arkWindow.document.createElement("a");
              a.href = resolved;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.click();
            }
          };

          // OscLinkProvider の confirm ダイアログを自動承認
          const origConfirm = iframeWindow.confirm.bind(iframeWindow);
          const OSC_CONFIRM_MARKER =
            "WARNING: This link could potentially be dangerous";
          // biome-ignore lint/suspicious/noExplicitAny: iframe window の confirm を上書き
          (iframeWindow as any).confirm = (message?: string): boolean => {
            if (
              typeof message === "string" &&
              message.includes(OSC_CONFIRM_MARKER)
            ) {
              return true;
            }
            return origConfirm(message);
          };

          // window.open 封じ込め（capture phase で止まらなかった場合の fallback）
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のwindow.openをオーバーライド
          (iframeWindow as any).open = (
            url?: string | URL,
            _target?: string,
            _features?: string
          ): Window | null => {
            if (url) {
              openUrl(String(url));
              return null;
            }
            return {
              opener: null,
              location: {
                _href: "",
                set href(u: string) {
                  openUrl(u);
                },
                get href() {
                  return this._href;
                },
              },
              close() {},
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js互換の最小実装
            } as any;
          };

          // ── 本丸: capture phase でクリックイベントを先取り ──
          //
          // Linkifier2 は mouseup で activate を呼ぶ。ブラウザ拡張機能も
          // click/mouseup を検知して URL を開く。capture phase で
          // stopImmediatePropagation すれば両方とも防げる。
          // _currentLink から URL を抽出して自前で1回だけ開く。
          const iframeDoc = iframeWindow.document;

          const extractCurrentLinkUrl = (): string | null => {
            try {
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js 内部 API
              const core = (term as any)._core;
              const linkifier =
                core?.linkifier ?? core?._linkifier2 ?? core?.linkifier2;
              const currentLink = linkifier?._currentLink;
              const text = currentLink?.link?.text;
              if (typeof text === "string" && text.length > 0) return text;
            } catch {
              // 内部構造変更時は無視
            }
            return null;
          };

          // mouseup/click のみ capture phase で先取りして Linkifier2 より先に処理。
          // pointerdown/mousedown は通す（Linkifier2 の _mouseDownLink 記録に必要、
          // かつテキスト選択機能を維持）。
          // _currentLink は hover 時に設定済みなので mouseup 時点で参照可能。
          const handleMouseUpIntercept = (e: Event): void => {
            // 左クリックのみ処理（右クリック・中クリックは通す）
            if (e instanceof MouseEvent && e.button !== 0) return;
            const url = extractCurrentLinkUrl();
            if (!url) return;
            // ファイルパスリンクはxterm.jsのactivateに委譲（ark:open-file経由で処理）
            if (!url.startsWith("http://") && !url.startsWith("https://"))
              return;
            e.stopImmediatePropagation();
            e.preventDefault();
            // mouseup でのみ URL を開く（Linkifier2 と同じタイミング）
            if (e.type === "mouseup") openUrl(url);
          };

          iframeDoc.addEventListener("mouseup", handleMouseUpIntercept, {
            capture: true,
          });
          iframeDoc.addEventListener("click", handleMouseUpIntercept, {
            capture: true,
          });

          // ── モバイルスワイプスクロール ──
          if (isMobile) {
            let touchStartY = 0;
            let touchSentLines = 0;
            let isSwiping = false;
            const SWIPE_LINE_HEIGHT = 8;
            const SWIPE_THRESHOLD = 3;

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
                  const wheelDeltaY =
                    deltaY > 0 ? -newLines * 16 : newLines * 16;
                  const xtermEl =
                    iframeDoc.querySelector(".xterm-viewport") ||
                    iframeDoc.querySelector(".xterm-screen") ||
                    iframeDoc.querySelector(".xterm");
                  if (xtermEl) {
                    const IframeWheelEvent = (
                      iframeWindow as unknown as typeof globalThis
                    ).WheelEvent;
                    xtermEl.dispatchEvent(
                      new IframeWheelEvent("wheel", {
                        deltaY: wheelDeltaY,
                        deltaMode: 0,
                        bubbles: true,
                        cancelable: true,
                      })
                    );
                  }
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

          // ── ファイルパスリンクプロバイダー ──
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
              let match: RegExpExecArray | null;

              if (urlExtensionMap.size > 100) {
                const firstKey = urlExtensionMap.keys().next().value;
                if (firstKey !== undefined) urlExtensionMap.delete(firstKey);
              }

              const urlRanges: Array<{ start: number; end: number }> = [];
              const urlRegex = /https?:\/\/[^\s<>"'()]+/g;
              while ((match = urlRegex.exec(text)) !== null) {
                let matchedUrl = match[0];
                const originalUrl = match[0];

                urlRanges.push({
                  start: match.index,
                  end: match.index + originalUrl.length,
                });

                const afterUrl = text.substring(
                  match.index + matchedUrl.length
                );
                if (/^\s*$/.test(afterUrl)) {
                  const maxExtensionLines = 10;
                  for (
                    let nextIdx = lineNumber;
                    nextIdx < lineNumber + maxExtensionLines;
                    nextIdx++
                  ) {
                    const nextLine = term.buffer.active.getLine(nextIdx);
                    if (!nextLine) break;
                    const nextText = nextLine.translateToString();
                    const trimmedNext = nextText.trimStart();
                    if (trimmedNext.length === 0) break;
                    const contMatch = trimmedNext.match(/^[^\s<>"'()]+/);
                    if (!contMatch) break;

                    const leadingSpaces = nextText.length - trimmedNext.length;
                    const afterCont = nextText.substring(
                      leadingSpaces + contMatch[0].length
                    );
                    if (!/^\s*$/.test(afterCont)) break;

                    matchedUrl += contMatch[0];
                  }
                }

                matchedUrl = matchedUrl.replace(/[.,;:!?]+$/, "");

                if (matchedUrl !== originalUrl) {
                  urlExtensionMap.set(originalUrl, matchedUrl);
                }
              }

              const inUrlRange = (idx: number): boolean =>
                urlRanges.some(r => idx >= r.start && idx < r.end);

              const fileRegex =
                /(?:file:([a-zA-Z0-9_.\-/]+)|([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+))(?::(\d+))?/g;
              while ((match = fileRegex.exec(text)) !== null) {
                if (inUrlRange(match.index)) continue;
                const fullMatch = match[0];
                const rawPath = match[1] || match[2];
                const filePath = rawPath?.replace(/^\/{2,}/, "/");
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
