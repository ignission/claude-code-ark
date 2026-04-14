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
          // WebLinksAddon fallback経路（独自providerが拾えなかった場合）で
          // 完全URLに復元するために使う。独自providerのactivateは finalUrl を
          // 直接open()に渡すためmapに依存しないが、WebLinksAddonが先に発火した
          // 場合に備えて引き続き構築する。
          const urlExtensionMap = new Map<string, string>();

          // URL open のdedupトークン。
          // 同一URLが短時間に2回開かれる（独自provider + WebLinksAddon の両発火）
          // のを防ぐ。独自providerのactivateで先にセットされ、WebLinksAddonの
          // fakeWindow.href設定時に同じURLなら無視する。
          const recentlyOpened = new Map<string, number>();
          const DEDUP_WINDOW_MS = 300;
          const markOpened = (u: string) => {
            recentlyOpened.set(u, Date.now());
            // 定期的に古いエントリをクリーンアップ（メモリ防衛）
            if (recentlyOpened.size > 50) {
              const now = Date.now();
              for (const [k, t] of recentlyOpened) {
                if (now - t > DEDUP_WINDOW_MS) recentlyOpened.delete(k);
              }
            }
          };
          const isRecentlyOpened = (u: string) => {
            const t = recentlyOpened.get(u);
            if (t === undefined) return false;
            if (Date.now() - t > DEDUP_WINDOW_MS) {
              recentlyOpened.delete(u);
              return false;
            }
            return true;
          };

          // URL実オープン処理（localhost→postMessage / 非localhost→origOpen）
          const openUrl = (urlStr: string) => {
            if (
              /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(urlStr)
            ) {
              arkWindow.postMessage(
                { type: "ark:open-url", url: urlStr },
                arkWindow.location.origin
              );
            } else {
              const real = origOpen();
              if (real) {
                try {
                  real.opener = null;
                } catch {}
                real.location.href = urlStr;
              }
            }
          };

          // xterm.js WebLinksAddonのURLを横取りする。
          // WebLinksAddonは window.open() を引数なしで呼び、返されたウィンドウの
          // location.href にURLを設定するパターン:
          //   const newWindow = window.open();
          //   newWindow.opener = null;
          //   newWindow.location.href = uri;
          // そのため、フェイクWindowオブジェクトを返してlocation.hrefのセッターで
          // URLを検出し、postMessageに変換する。
          const arkWindow = window;
          const origOpen = iframeWindow.open.bind(iframeWindow);
          // biome-ignore lint/suspicious/noExplicitAny: ttyd iframe内のwindow.openをオーバーライドするため型を緩める
          (iframeWindow as any).open = (
            url?: string | URL,
            target?: string,
            features?: string
          ): Window | null => {
            // 引数ありの呼び出し（独自provider側activate or URL直接指定）
            if (url) {
              const rawStr = String(url);
              // urlExtensionMap経由の復元は独自provider側で済んでいるが、
              // 外部呼び出し互換のため引き続きmap参照を行う
              const urlStr = urlExtensionMap.get(rawStr) || rawStr;
              if (isRecentlyOpened(urlStr)) return null;
              markOpened(urlStr);
              if (
                /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/.test(urlStr)
              ) {
                arkWindow.postMessage(
                  { type: "ark:open-url", url: urlStr },
                  arkWindow.location.origin
                );
                return null;
              }
              return origOpen(urlStr, target, features);
            }

            // 引数なしの呼び出し（WebLinksAddonパターン）
            // フェイクWindowを返し、location.hrefセッターでURLを横取り
            const fakeWindow = {
              opener: null,
              location: {
                _href: "",
                set href(u: string) {
                  // URL拡張マップで折り返しURLを完全URLに復元
                  const resolved = urlExtensionMap.get(u) || u;
                  if (isRecentlyOpened(resolved)) return;
                  markOpened(resolved);
                  openUrl(resolved);
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
          // iframe内のtouchイベントを検知し、xterm.jsのバッファを直接スクロールする。
          // Claude CLIは代替スクリーンバッファ（smcup/rmcup）を使うため tmux copy-mode は
          // 使えないが、xterm.js側には出力がそのままあるためそちらをスクロールする。
          if (isMobile) {
            const iframeDoc = iframeWindow.document;
            let touchStartY = 0;
            let touchSentLines = 0;
            let isSwiping = false;
            const SWIPE_LINE_HEIGHT = 8; // 8pxで1行スクロール（高感度）
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
                  // 指を上にスワイプ (deltaY > 0) → 過去の出力を見たい → ホイールを上回転 → deltaY負。
                  // xterm.jsのwheelハンドラに渡すため、xterm要素にWheelEventをdispatchする。
                  // term.scrollLines() はttyd環境では viewport に反映されないケースがあり、
                  // PC のマウスホイールと同じ経路（tmux mouse protocol → copy-mode、または
                  // xterm.js内部scrollback）を通すためwheel dispatchを使う。
                  const wheelDeltaY =
                    deltaY > 0 ? -newLines * 16 : newLines * 16; // 1行≈16px
                  const xtermEl =
                    iframeDoc.querySelector(".xterm-viewport") ||
                    iframeDoc.querySelector(".xterm-screen") ||
                    iframeDoc.querySelector(".xterm");
                  if (xtermEl) {
                    // WheelEvent は iframe 側のコンストラクタで生成する。
                    // 親 realm の `new WheelEvent(...)` は Firefox の realm 検証で
                    // dispatch が失敗しうる、Safari ではプロパティが正しく機能しない
                    // 可能性があるため、同一 realm で生成する。
                    const IframeWheelEvent = (
                      iframeWindow as unknown as typeof globalThis
                    ).WheelEvent;
                    xtermEl.dispatchEvent(
                      new IframeWheelEvent("wheel", {
                        deltaY: wheelDeltaY,
                        deltaMode: 0, // DOM_DELTA_PIXEL
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

              // URL範囲を記録する配列。ファイルパス検出時にURL内部の部分文字列が
              // 誤マッチするのを防ぐため、URL検出を先に走らせて範囲を収集しておく。
              const urlRanges: Array<[number, number]> = [];
              const inUrlRange = (idx: number) =>
                urlRanges.some(([s, e]) => idx >= s && idx < e);

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

                // 1行目のURL範囲を記録（ファイルパス検出時の除外判定に使用）
                urlRanges.push([match.index, match.index + originalUrl.length]);

                // URLの直後から行末まで空白のみか確認（URLが行の最後のトークン）
                const afterUrl = text.substring(
                  match.index + matchedUrl.length
                );
                if (/^\s*$/.test(afterUrl)) {
                  // 次行以降からURL継続部分を取得（最大10行まで）。
                  // ここでは urlExtensionMap 構築のみ行い、継続行のリンク登録は
                  // 行わない（provideLinksは行ごとに呼ばれるため、継続行の
                  // リンク登録は別のprovideLinks呼び出しで行う必要がある）。
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

                    // 継続部分の直後が行末でなければ、この行はURL継続ではない
                    const leadingSpaces = nextText.length - trimmedNext.length;
                    const afterCont = nextText.substring(
                      leadingSpaces + contMatch[0].length
                    );
                    if (!/^\s*$/.test(afterCont)) break;

                    matchedUrl += contMatch[0];
                  }
                }

                // 末尾の句読点を除去（文中のURL: "See https://example.com." 等）
                // 1行目固有の trailing 句読点長も計算してリンク範囲調整に使う。
                const trimmed = matchedUrl.replace(/[.,;:!?]+$/, "");
                // 1行目内のtrailing句読点長（拡張行の有無に関わらず、1行目に
                // 句読点があればその分だけ範囲を縮める）
                const firstLineTrimChars =
                  originalUrl.length -
                  originalUrl.replace(/[.,;:!?]+$/, "").length;
                matchedUrl = trimmed;

                // 拡張された場合、元URL→完全URLの対応をMapに記録
                // WebLinksAddonのactivate時にfakeWindowで完全URLに復元する
                if (matchedUrl !== originalUrl) {
                  urlExtensionMap.set(originalUrl, matchedUrl);
                }

                // 1行目のリンクを登録する。activate は fakeWindow override を
                // 経由し、recentlyOpened による dedup で WebLinksAddon の両発火を
                // 防ぐ。finalUrl を直接渡すため urlExtensionMap 依存はなく、
                // prefix衝突や100件制限によるprefix退避の影響も受けない。
                // 範囲は trailing句読点を除いた長さで算出（クリック誤判定防止）
                const finalUrl = matchedUrl;
                const firstLineEndIdx =
                  match.index + originalUrl.length - firstLineTrimChars;
                links.push({
                  range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: {
                      x: firstLineEndIdx + 1,
                      y: lineNumber,
                    },
                  },
                  text: finalUrl,
                  activate() {
                    // biome-ignore lint/suspicious/noExplicitAny: overrideされたopenを呼ぶため型を緩める
                    (iframeWindow as any).open(finalUrl, "_blank");
                  },
                });
              }

              // ファイルパス検出
              // 1. file:プレフィックス付き（拡張子不問）: file:Dockerfile, file:src/main.rs:42
              // 2. パス区切り+拡張子付き: src/App.tsx:10
              // URL内部の部分文字列にマッチしないよう urlRanges で除外する
              const fileRegex =
                /(?:file:([a-zA-Z0-9_.\-/]+)|([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+))(?::(\d+))?/g;
              while ((match = fileRegex.exec(text)) !== null) {
                // マッチ先頭がURL範囲内ならスキップ（URL内部の誤検出を防ぐ）
                if (inUrlRange(match.index)) continue;

                const fullMatch = match[0];
                // file:///path の場合、先頭の余分なスラッシュを除去して /path にする
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
