/**
 * noVNC はサーバーからカーソル形状 (Cursor pseudo-encoding) が届くまで、
 * canvas の cursor を `none` にして何も描かない。macOS の画面共有は
 * サードパーティの VNC クライアントにカーソル形状を送らないため、
 * そのままでは矢印が一切見えず、どこを指しているか分からない。
 *
 * サーバーのカーソルが届くまでは、ブラウザ自身の矢印を出しておく。
 * ポインタの位置はそのまま VM 側へ送っているので、矢印は「いま指している場所」
 * を正しく示す。サーバーがカーソルを送ってきたら (cursor が `url(...)` になったら)
 * 以後は noVNC に任せる。
 *
 * noVNC がタッチ端末や data URI カーソル非対応のブラウザで使う「別 canvas に
 * カーソルを描く」経路では、対象 canvas の cursor は常に `none` のままなので、
 * この保険を掛けると矢印とサーバーのカーソルが二重に出る。その経路 (noVNC の
 * `useFallback` と同じ判定) では何もしない。
 *
 * @param options.usesFallback noVNC が別 canvas 経路を使うか。省略時は自前で判定する
 *   (テストの jsdom はタッチ端末に見えるので、注入できるようにしてある)
 * @returns 監視を止める関数
 */
export function keepLocalCursorUntilServerCursor(
  target: HTMLElement,
  options: { usesFallback?: boolean } = {}
): () => void {
  if (options.usesFallback ?? usesFallbackCursor()) {
    return () => {};
  }

  let serverCursorSeen = false;

  const apply = () => {
    const cursor = target.style.cursor;
    if (isServerCursor(cursor)) {
      serverCursorSeen = true;
      return;
    }
    if (!serverCursorSeen && cursor === "none") {
      target.style.cursor = "default";
    }
  };

  apply();
  if (typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(records => {
    // 同じタスク内で url → none と続けて書かれると、通知が届くころには none
    // しか見えない。旧値に url があれば、サーバーのカーソルは届いたと判定する
    if (records.some(record => hasServerCursorInStyle(record.oldValue))) {
      serverCursorSeen = true;
    }
    apply();
    if (serverCursorSeen) observer.disconnect();
  });
  observer.observe(target, {
    attributes: true,
    attributeFilter: ["style"],
    attributeOldValue: true,
  });
  return () => observer.disconnect();
}

function isServerCursor(cursor: string): boolean {
  return cursor.startsWith("url(");
}

/** style 属性の文字列 (MutationRecord.oldValue) に url のカーソルが含まれるか */
function hasServerCursorInStyle(style: string | null): boolean {
  return style !== null && /(?:^|;)\s*cursor\s*:\s*url\(/i.test(style);
}

/**
 * noVNC の `useFallback` (core/util/cursor.js) と同じ判定。
 * タッチ端末、または data URI のカーソルを CSS が受け付けないブラウザ
 */
export function usesFallbackCursor(): boolean {
  const nav = navigator as Navigator & { msMaxTouchPoints?: number };
  const isTouchDevice =
    "ontouchstart" in document.documentElement ||
    document.ontouchstart !== undefined ||
    nav.maxTouchPoints > 0 ||
    (nav.msMaxTouchPoints ?? 0) > 0;
  if (isTouchDevice) return true;
  try {
    const probe = document.createElement("canvas");
    probe.style.cursor =
      'url("data:image/x-icon;base64,AAACAAEACAgAAAIAAgA4AQAAFgAAACgAAAAIAAAAEAAAAAEAIAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAA=") 2 2, default';
    return !probe.style.cursor.startsWith("url");
  } catch {
    return true;
  }
}
