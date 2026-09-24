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
 * @returns 監視を止める関数
 */
export function keepLocalCursorUntilServerCursor(
  target: HTMLElement
): () => void {
  let serverCursorSeen = false;

  const apply = () => {
    const cursor = target.style.cursor;
    if (cursor.startsWith("url(")) {
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
  const observer = new MutationObserver(() => {
    apply();
    if (serverCursorSeen) observer.disconnect();
  });
  observer.observe(target, { attributes: true, attributeFilter: ["style"] });
  return () => observer.disconnect();
}
