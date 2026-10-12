/**
 * ブラウザ機能のコピー。リモートのページで選んでいる文字列を、手元のクリップボードへ書く。
 *
 * 書くのは、このペインが読みに行ったとき (`requestCopy`) だけ。サーバーの `clipboard` は、
 * 頼んでから `COPY_REQUEST_TTL_MS` までに届いた最初の1通だけを使い、頼んでいないもの、
 * 遅れて届いたもの、2通目は捨てる。利用者がコピーの操作をしていないのに、手元の
 * クリップボードがリモートのページの文字列で書き換わることを防ぐ (ほかの視聴者の操作や、
 * 遅れた返事で上書きしない)。
 *
 * 書けなければ (権限が無い、安全でないコンテキストで `navigator.clipboard` が無い)、
 * `onFail` を呼ぶだけにする。
 */

import type { BrowserClientMessage } from "@ark/shared";
import { useCallback, useLayoutEffect, useRef } from "react";

/** `copy` を送ってから、この時間 (ミリ秒) までに届いた `clipboard` だけを書く */
export const COPY_REQUEST_TTL_MS = 3000;

export interface UseBrowserClipboardOptions {
  send: (msg: BrowserClientMessage) => void;
  /** 手元のクリップボードへ書けなかった */
  onFail: () => void;
}

export interface BrowserClipboard {
  /** リモートで選んでいる文字列を読みに行く */
  requestCopy: () => void;
  /** サーバーの `clipboard` を受け取った。頼んだ分だけを書く */
  receive: (text: unknown) => void;
  /** 接続をやり直すとき。前の接続で頼んだ分を忘れる */
  reset: () => void;
}

export function useBrowserClipboard(
  options: UseBrowserClipboardOptions
): BrowserClipboard {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  // 返事を待っている `copy` を送った時刻。待っていなければ `null`
  const requestedAtRef = useRef<number | null>(null);

  const requestCopy = useCallback(() => {
    requestedAtRef.current = performance.now();
    optionsRef.current.send({ t: "copy" });
  }, []);

  const receive = useCallback((text: unknown) => {
    const requestedAt = requestedAtRef.current;
    requestedAtRef.current = null;
    if (
      requestedAt === null ||
      performance.now() - requestedAt > COPY_REQUEST_TTL_MS ||
      typeof text !== "string"
    ) {
      return;
    }
    const fail = () => optionsRef.current.onFail();
    try {
      // 安全でないコンテキストでは `navigator.clipboard` が無い
      const written = navigator.clipboard?.writeText(text);
      if (written) written.catch(fail);
      else fail();
    } catch {
      fail();
    }
  }, []);

  const reset = useCallback(() => {
    requestedAtRef.current = null;
  }, []);

  return { requestCopy, receive, reset };
}
