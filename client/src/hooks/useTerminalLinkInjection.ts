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

          // localhost 判定を URL パーサで厳密化する。
          // 正規表現では `http://localhost.evil.example/` のようなサブドメインで
          // trueになる可能性があるため、hostname を完全一致で比較する。
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

          // クリック世代ベースのdedup。
          // xterm.js は WebLinksAddon（正規表現）と組み込みの OscLinkProvider
          // （OSC 8 ハイパーリンク）を両方登録している。Claude CLI が URL を
          // OSC 8 で包んで出力すると、両プロバイダが同じ範囲にリンクを張り、
          // 1回のクリックで両方の activate が発火 → iframeWindow.open が
          // 2回呼ばれて2タブ開く。
          // URL文字列ベースの dedup では、両プロバイダが渡す文字列が末尾句読点・
          // URLエンコーディング・表示文字列/href 差等で1文字でも異なると素通り
          // するため、より頑健な「1クリック=1タブ」の世代カウンタ方式を採用する。
          // pointerdown/click を capture フェーズで捕捉し世代を進め、
          // window.open override 側で「この世代でまだ open していなければ許可、
          // 既に open 済みなら拒否」とする。
          let clickGeneration = 0;
          let openedInGeneration = -1;
          const bumpGeneration = () => {
            clickGeneration++;
          };
          const iframeDocForClicks = iframeWindow.document;
          iframeDocForClicks.addEventListener("pointerdown", bumpGeneration, {
            capture: true,
            passive: true,
          });
          iframeDocForClicks.addEventListener("click", bumpGeneration, {
            capture: true,
            passive: true,
          });
          const tryClaimOpen = (): boolean => {
            if (openedInGeneration === clickGeneration) return false;
            openedInGeneration = clickGeneration;
            return true;
          };

          // xterm.js 組み込みの OscLinkProvider は URL クリック時に
          // `confirm("Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous")`
          // を表示する。UX としてこのダイアログを出したくないのと、Claude CLI の
          // OSC 8 はリンクテキスト=URL で phishing リスクがないため、該当メッセージ
          // に一致する confirm のみ自動承認する。他のコードパスが confirm を使う
          // 場合は origConfirm に委譲。
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
            // 引数ありの呼び出し（URL直接指定）
            if (url) {
              const urlStr = urlExtensionMap.get(String(url)) || String(url);
              if (!tryClaimOpen()) return null;
              if (isLoopbackUrl(urlStr)) {
                arkWindow.postMessage(
                  { type: "ark:open-url", url: urlStr },
                  arkWindow.location.origin
                );
                return null;
              }
              // 非localhost: 空URLで新タブを開き opener=null を付与してから
              // location.href を設定する（タブナビゲーション攻撃対策）
              const real = origOpen("", target, features);
              if (real) {
                try {
                  real.opener = null;
                } catch {}
                real.location.href = urlStr;
              }
              return real;
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
                  if (!tryClaimOpen()) return;
                  if (isLoopbackUrl(resolved)) {
                    arkWindow.postMessage(
                      { type: "ark:open-url", url: resolved },
                      arkWindow.location.origin
                    );
                  } else {
                    // localhost以外は実際に新しいウィンドウで開く
                    const real = origOpen();
                    if (real) {
                      try {
                        real.opener = null;
                      } catch {}
                      real.location.href = resolved;
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

              // URL検出を先に実行し、1行目の URL 範囲を urlRanges に記録する。
              // 後続の file 検出でこの範囲内のマッチを除外することで、
              // URL 内部の部分文字列（例: `https://example.com/path/foo.js`）が
              // file リンクとして独立登録されるのを防ぐ。
              // URL クリック自体は WebLinksAddon に一本化するため、ここでは
              // links.push はせず、折り返し完全URL復元用の urlExtensionMap
              // のみを維持する。
              //
              // Mapサイズ上限（メモリリーク防止。clearはprovideLinksが行ごとに
              // 呼ばれるためクリック時にマッピングが消失する問題がある）
              if (urlExtensionMap.size > 100) {
                const firstKey = urlExtensionMap.keys().next().value;
                if (firstKey !== undefined) urlExtensionMap.delete(firstKey);
              }

              const urlRanges: Array<{ start: number; end: number }> = [];
              const urlRegex = /https?:\/\/[^\s<>"'()]+/g;
              while ((match = urlRegex.exec(text)) !== null) {
                let matchedUrl = match[0];
                const originalUrl = match[0];

                // 1 行目の URL 範囲を記録（file 検出で重複を避けるため）
                urlRanges.push({
                  start: match.index,
                  end: match.index + originalUrl.length,
                });

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
                matchedUrl = matchedUrl.replace(/[.,;:!?]+$/, "");

                // 拡張された場合、元URL→完全URLの対応をMapに記録
                // WebLinksAddonが activate された際、fakeWindow で完全URLに復元する
                if (matchedUrl !== originalUrl) {
                  urlExtensionMap.set(originalUrl, matchedUrl);
                }
              }

              const inUrlRange = (idx: number): boolean =>
                urlRanges.some(r => idx >= r.start && idx < r.end);

              // ファイルパス検出
              // 1. file:プレフィックス付き（拡張子不問）: file:Dockerfile, file:src/main.rs:42
              // 2. パス区切り+拡張子付き: src/App.tsx:10
              const fileRegex =
                /(?:file:([a-zA-Z0-9_.\-/]+)|([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+))(?::(\d+))?/g;
              while ((match = fileRegex.exec(text)) !== null) {
                // URL 内部の部分文字列マッチはスキップ
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
