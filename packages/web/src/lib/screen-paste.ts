/** XK_v (core/input/keysym.js)。noVNC の package.json は rfb.js しか export しない */
const XK_V = 0x0076;

/** forwardLocalPaste が使う RFB の口。テストで差し替えられるようにする */
export interface PasteTarget {
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

/**
 * リモート画面で Cmd/Ctrl+V を押したとき、手元のクリップボードを貼る。
 *
 * noVNC は手元のクリップボードを相手へ送らない。キーをそのまま流すと、
 * 相手側のクリップボードが貼られる。また noVNC は keydown の既定動作を止めるので、
 * ブラウザの paste イベントは発火しない。そこで V の keydown を noVNC (canvas) より
 * 先に捕捉フェーズで奪い、クリップボードを読んで送ってから V を押し直す。
 * 修飾キーの keydown は奪わないので、相手側では押されたままになっている。
 *
 * クリップボードを読めない (権限の拒否など) ときは V だけを押し、従来どおり
 * 相手側のクリップボードで貼る。
 * 文字の範囲は noVNC の clipboardPasteFrom の制約を受ける。サーバーが拡張
 * クリップボードに対応していれば UTF-8 で、していなければ ISO 8859-1 で送られ、
 * その範囲の外の文字 (日本語など) は `?` になる。
 *
 * @returns 監視を止める関数
 */
export function forwardLocalPaste(
  container: HTMLElement,
  getTarget: () => PasteTarget | null,
  readText: () => Promise<string> = () => navigator.clipboard.readText()
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "v")
      return;
    const target = getTarget();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    readText().then(
      text => {
        const current = getTarget();
        if (!current) return;
        current.clipboardPasteFrom(text);
        current.sendKey(XK_V, "KeyV");
      },
      () => {
        // 読めなかったら、相手側のクリップボードで貼る従来の動きに戻す
        getTarget()?.sendKey(XK_V, "KeyV");
      }
    );
  };
  container.addEventListener("keydown", onKeyDown, true);
  return () => container.removeEventListener("keydown", onKeyDown, true);
}
