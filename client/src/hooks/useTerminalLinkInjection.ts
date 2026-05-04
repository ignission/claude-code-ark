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

          // ── ファイルパス・URL リンク検出ヘルパー ──
          //
          // xterm.js は折り返し行を別バッファ行として保持し、継続行に
          // isWrapped = true を立てる。1行単位で regex を走らせると、
          // 折り返されたパス/URL は「拡張子なし」「スキーム/スラッシュなし」で
          // どちらの行でもマッチしない。
          // 対策: 論理行（isWrapped 継続を全て連結）を再構築してから検出し、
          // マッチが現在行に重なる範囲にのみリンクを登録する。

          // biome-ignore lint/suspicious/noExplicitAny: xterm.js Buffer line API
          const getLineSafe = (idx: number): any =>
            term.buffer.active.getLine(idx) ?? null;

          /**
           * cur が prev の継続行かどうか判定。
           * - xterm 自動折り返し: cur.isWrapped === true
           * - Claude/CLI のインデント折り返し:
           *     prev が末尾に空白なくトークンで終わる
           *     かつ cur が「先頭空白 + 1トークン + 末尾空白なし or 空のみ」
           */
          // biome-ignore lint/suspicious/noExplicitAny: xterm.js Buffer line objects
          const isContinuation = (cur: any, prev: any): boolean => {
            if (!cur || !prev) return false;
            if (cur.isWrapped) return true;
            const prevText = prev.translateToString(true);
            if (prevText.length === 0) return false;
            if (/\s$/.test(prevText)) return false;
            const curText = cur.translateToString(true);
            const trimmed = curText.trimStart();
            if (trimmed.length === 0) return false;
            const tokenMatch = trimmed.match(/^[^\s<>"'()]+/);
            if (!tokenMatch) return false;
            const after = trimmed.substring(tokenMatch[0].length);
            return /^\s*$/.test(after);
          };

          /** 現在行が属する論理行の先頭バッファインデックスを返す */
          const findLogicalLineStart = (lineIdx: number): number => {
            let i = lineIdx;
            while (i > 0) {
              if (!isContinuation(getLineSafe(i), getLineSafe(i - 1))) break;
              i--;
            }
            return i;
          };

          /**
           * startIdx から継続行を全て連結したセグメント情報を返す。
           * 各セグメントは表示行（バッファ1行）に対応し、継続行のリーディング
           * 空白は除去されるが、セグメントは visibleColOffset でその空白幅を保持する。
           */
          type LineSegment = {
            bufferIdx: number;
            visibleColOffset: number;
            segmentText: string;
            startInJoined: number;
            endInJoined: number;
          };
          const buildLogicalLine = (
            startIdx: number,
            maxLines = 20
          ): { joined: string; segments: LineSegment[] } => {
            const segments: LineSegment[] = [];
            const first = getLineSafe(startIdx);
            if (!first) return { joined: "", segments: [] };
            const firstText = first.translateToString(true);
            segments.push({
              bufferIdx: startIdx,
              visibleColOffset: 0,
              segmentText: firstText,
              startInJoined: 0,
              endInJoined: firstText.length,
            });
            let cursor = firstText.length;
            for (let i = startIdx + 1; i < startIdx + maxLines; i++) {
              const ln = getLineSafe(i);
              const prev = getLineSafe(i - 1);
              if (!isContinuation(ln, prev)) break;
              const lineText = ln.translateToString(true);
              const stripped = lineText.trimStart();
              const visibleColOffset = lineText.length - stripped.length;
              segments.push({
                bufferIdx: i,
                visibleColOffset,
                segmentText: stripped,
                startInJoined: cursor,
                endInJoined: cursor + stripped.length,
              });
              cursor += stripped.length;
            }
            return {
              joined: segments.map(s => s.segmentText).join(""),
              segments,
            };
          };

          /**
           * 指定した1-indexed バッファ行に表示されるリンクを検出する。
           * provideLinks とモバイルタップ検出の両方から呼ぶ。
           *
           * @param includeUrlStartLine
           *   true: URL の開始セグメント (1行目に収まる URL を含む) も自前リンクとして登録する。
           *         モバイルタップ検出から呼ぶ場合は WebLinksAddon が機能しないため必須。
           *   false: URL の開始セグメントは WebLinksAddon に委譲してスキップする。
           *          PC の provideLinks (xterm Linkifier2) から呼ぶ場合のデフォルト。
           */
          const detectLinksForLine = (
            lineNumber: number,
            includeUrlStartLine = false
          ) => {
            const bufferIdx = lineNumber - 1;
            const line = getLineSafe(bufferIdx);
            if (!line) return [];

            if (urlExtensionMap.size > 100) {
              const firstKey = urlExtensionMap.keys().next().value;
              if (firstKey !== undefined) urlExtensionMap.delete(firstKey);
            }

            const logicalStart = findLogicalLineStart(bufferIdx);
            const { joined, segments } = buildLogicalLine(logicalStart);
            const mySegment = segments.find(s => s.bufferIdx === bufferIdx);
            if (!mySegment) return [];

            type DetectedLink = {
              range: {
                start: { x: number; y: number };
                end: { x: number; y: number };
              };
              text: string;
              activate: () => void;
            };
            const links: DetectedLink[] = [];

            const pushVisibleLink = (
              matchStart: number,
              matchEnd: number,
              activate: () => void
            ) => {
              const visStart = Math.max(matchStart, mySegment.startInJoined);
              const visEnd = Math.min(matchEnd, mySegment.endInJoined);
              if (visEnd <= visStart) return;
              const startCol =
                mySegment.visibleColOffset +
                (visStart - mySegment.startInJoined) +
                1;
              const endCol =
                mySegment.visibleColOffset +
                (visEnd - mySegment.startInJoined) +
                1;
              links.push({
                range: {
                  start: { x: startCol, y: lineNumber },
                  end: { x: endCol, y: lineNumber },
                },
                text: joined.slice(visStart, visEnd),
                activate,
              });
            };

            // ── URL 検出（論理行全体 = joined） ──
            type UrlMatch = { start: number; end: number; url: string };
            const urlMatches: UrlMatch[] = [];
            const urlRegex = /https?:\/\/[^\s<>"'()]+/g;
            for (
              let mUrl = urlRegex.exec(joined);
              mUrl !== null;
              mUrl = urlRegex.exec(joined)
            ) {
              const cleaned = mUrl[0].replace(/[.,;:!?]+$/, "");
              urlMatches.push({
                start: mUrl.index,
                end: mUrl.index + cleaned.length,
                url: cleaned,
              });
            }

            for (const m of urlMatches) {
              // URL 開始セグメント = WebLinksAddon が見える URL 範囲
              const startSeg = segments.find(
                s => m.start >= s.startInJoined && m.start < s.endInJoined
              );
              if (startSeg) {
                const truncatedOnFirst = joined.slice(
                  m.start,
                  Math.min(m.end, startSeg.endInJoined)
                );
                if (truncatedOnFirst.length > 0 && truncatedOnFirst !== m.url) {
                  urlExtensionMap.set(truncatedOnFirst, m.url);
                }
                // 1行目は WebLinksAddon に委譲 (PC ホバー)。モバイルタップ
                // (includeUrlStartLine=true) では WebLinksAddon が機能しないため自前で登録。
                if (!includeUrlStartLine && startSeg.bufferIdx === bufferIdx) {
                  continue;
                }
              }
              pushVisibleLink(m.start, m.end, () => openUrl(m.url));
            }

            const inUrlRange = (idx: number): boolean =>
              urlMatches.some(r => idx >= r.start && idx < r.end);

            // ── ファイルパス検出（論理行全体 = joined） ──
            const fileRegex =
              /(?:file:([a-zA-Z0-9_.\-/]+)|([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+))(?::(\d+))?/g;
            for (
              let mFile = fileRegex.exec(joined);
              mFile !== null;
              mFile = fileRegex.exec(joined)
            ) {
              if (inUrlRange(mFile.index)) continue;
              const fullMatch = mFile[0];
              const rawPath = mFile[1] || mFile[2];
              const filePath = rawPath?.replace(/^\/{2,}/, "/");
              const lineNum = mFile[3] ? Number.parseInt(mFile[3], 10) : null;
              if (!filePath) continue;
              pushVisibleLink(
                mFile.index,
                mFile.index + fullMatch.length,
                () => {
                  arkWindow.postMessage(
                    { type: "ark:open-file", path: filePath, line: lineNum },
                    arkWindow.location.origin
                  );
                }
              );
            }

            return links;
          };

          /**
           * モバイル: タップ座標から (line, col) を計算し、その位置にあるリンクを返す。
           */
          const findLinkAtTouchPoint = (
            clientX: number,
            clientY: number
          ): { activate: () => void } | null => {
            const screen = iframeDoc.querySelector(
              ".xterm-screen"
            ) as HTMLElement | null;
            if (!screen) return null;
            const rect = screen.getBoundingClientRect();
            const xRel = clientX - rect.left;
            const yRel = clientY - rect.top;
            if (
              xRel < 0 ||
              yRel < 0 ||
              xRel >= rect.width ||
              yRel >= rect.height
            )
              return null;

            // biome-ignore lint/suspicious/noExplicitAny: xterm.js 内部 API
            const dim = (term as any)._core?._renderService?.dimensions?.css
              ?.cell;
            const cellWidth: number = dim?.width ?? rect.width / term.cols;
            const cellHeight: number = dim?.height ?? rect.height / term.rows;
            if (!cellWidth || !cellHeight) return null;

            const col = Math.floor(xRel / cellWidth) + 1; // 1-indexed
            const visibleRow = Math.floor(yRel / cellHeight); // 0-indexed
            const viewportY = term.buffer.active.viewportY;
            const lineNumber = viewportY + visibleRow + 1;

            // モバイルタップでは WebLinksAddon が機能しないため、URL の1行目も
            // 含めて自前で検出する (includeUrlStartLine=true)。
            const links = detectLinksForLine(lineNumber, true);
            for (const link of links) {
              if (
                link.range.start.y === lineNumber &&
                col >= link.range.start.x &&
                col < link.range.end.x
              ) {
                return link;
              }
            }
            return null;
          };

          // ── モバイルスワイプスクロール + タップでリンク起動 ──
          if (isMobile) {
            let touchStartY = 0;
            let touchStartX = 0;
            let touchSentLines = 0;
            let isSwiping = false;
            let lastLinkTapAt = 0;
            const SWIPE_LINE_HEIGHT = 8;
            const SWIPE_THRESHOLD = 3;

            iframeDoc.addEventListener(
              "touchstart",
              (e: Event) => {
                const te = e as TouchEvent;
                touchStartY = te.touches[0].clientY;
                touchStartX = te.touches[0].clientX;
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
              (e: Event) => {
                const wasSwiping = isSwiping;
                touchSentLines = 0;
                isSwiping = false;
                if (wasSwiping) return;

                const te = e as TouchEvent;
                const touch = te.changedTouches[0];
                if (!touch) return;

                // タップ位置と開始位置の距離が閾値内のときのみリンク判定
                const dx = touch.clientX - touchStartX;
                const dy = touch.clientY - touchStartY;
                if (Math.hypot(dx, dy) > 12) return;

                const link = findLinkAtTouchPoint(touch.clientX, touch.clientY);
                if (!link) return;

                e.preventDefault();
                e.stopImmediatePropagation();
                link.activate();
                lastLinkTapAt = Date.now();
              },
              { capture: true, passive: false }
            );

            // synthesized mouse events を抑制
            // - mouseup: xterm Linkifier2 が activate() を二重実行するのを防ぐ
            // - mousedown / click: textarea フォーカス（キーボード表示）を防ぐ
            const suppressIfRecentLinkTap = (e: Event) => {
              if (Date.now() - lastLinkTapAt < 700) {
                e.preventDefault();
                e.stopImmediatePropagation();
              }
            };
            for (const evt of ["mousedown", "mouseup", "click"]) {
              iframeDoc.addEventListener(evt, suppressIfRecentLinkTap, {
                capture: true,
              });
            }
          }

          // ── xterm.js リンクプロバイダー登録（PC のホバー → クリック用） ──
          term.registerLinkProvider({
            provideLinks(
              lineNumber: number,
              // biome-ignore lint/suspicious/noExplicitAny: xterm.js link provider API
              callback: (links: any[] | undefined) => void
            ) {
              const links = detectLinksForLine(lineNumber);
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
