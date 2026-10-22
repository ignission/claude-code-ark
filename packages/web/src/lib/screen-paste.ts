/** keysym (core/input/keysym.js)。noVNC の package.json は rfb.js しか export しない */
const XK_V = 0x0076;
const XK_CONTROL_L = 0xffe3;
/** noVNC は Meta (Cmd) を Super として送る (core/input/domkeytable.js) */
const XK_SUPER_L = 0xffeb;

/** RFB の ClientCutText。拡張クリップボードでは長さが負になり、本文の前に操作のフラグが付く */
const CLIENT_CUT_TEXT = 6;
/** 拡張クリップボードの Provide 操作 (1 << 28) のフラグの先頭バイト */
const EXTENDED_PROVIDE_FLAG = 0x10;
/** Provide を待つ上限 (ミリ秒)。サーバーが本文を求めてこなくても V は押す */
const DELIVERY_TIMEOUT_MS = 1000;

/** forwardLocalPaste が使う RFB の口。テストで差し替えられるようにする */
export interface PasteTarget {
  /** 相手のクリップボードを書き換え、終わったら解決する */
  clipboardPasteFrom(text: string): void | Promise<void>;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

/**
 * リモート画面で Cmd/Ctrl+V を押したとき、手元のクリップボードを貼る。
 *
 * noVNC は手元のクリップボードを相手へ送らない。キーをそのまま流すと、
 * 相手側のクリップボードが貼られる。また noVNC は keydown の既定動作を止めるので、
 * ブラウザの paste イベントは発火しない。そこで V の keydown を noVNC (canvas) より
 * 先に捕捉フェーズで奪い、クリップボードを読んで相手のクリップボードを書き換えてから
 * V を押し直す。書き換えの手段は PasteTarget に任せる (ScreenPane が決める)。
 * 修飾キーの keydown は奪わないので、相手側では押されたままになっている。
 * ただし読み取りを待つあいだに修飾キーを離したり、権限の確認でウィンドウの
 * フォーカスが外れたりすると、noVNC が相手側の修飾キーを離す。その場合は
 * V の前後で修飾キーを押し直して離す。
 *
 * クリップボードを読めない (権限の拒否など) ときは V だけを押し、従来どおり
 * 相手側のクリップボードで貼る。
 *
 * @returns 監視を止める関数
 */
export function forwardLocalPaste(
  container: HTMLElement,
  getTarget: () => PasteTarget | null,
  readText: () => Promise<string> = () => navigator.clipboard.readText()
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    // 非ラテン配列では key が v にならないので、物理キーの code でも見る
    if (event.code !== "KeyV" && event.key.toLowerCase() !== "v") return;
    const target = getTarget();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();

    const modifiers: Array<[number, string]> = [];
    if (event.metaKey) modifiers.push([XK_SUPER_L, "MetaLeft"]);
    if (event.ctrlKey) modifiers.push([XK_CONTROL_L, "ControlLeft"]);
    let released = false;
    const onModifierChange = (e: KeyboardEvent) => {
      if ((event.metaKey && !e.metaKey) || (event.ctrlKey && !e.ctrlKey)) {
        released = true;
      }
    };
    const onBlur = () => {
      released = true;
    };
    container.addEventListener("keyup", onModifierChange, true);
    window.addEventListener("blur", onBlur);

    const pressV = () => {
      container.removeEventListener("keyup", onModifierChange, true);
      window.removeEventListener("blur", onBlur);
      const current = getTarget();
      if (!current) return;
      if (released) {
        for (const [keysym, code] of modifiers) {
          current.sendKey(keysym, code, true);
        }
      }
      current.sendKey(XK_V, "KeyV");
      if (released) {
        for (const [keysym, code] of modifiers) {
          current.sendKey(keysym, code, false);
        }
      }
    };

    // readText が同期で投げても (navigator.clipboard が無いなど) 失敗の側へ流す
    Promise.resolve()
      .then(readText)
      .then(
        async text => {
          try {
            await getTarget()?.clipboardPasteFrom(text);
          } finally {
            pressV();
          }
        },
        // 読めなかったら、相手側のクリップボードで貼る従来の動きに戻す
        pressV
      );
  };
  container.addEventListener("keydown", onKeyDown, true);
  return () => container.removeEventListener("keydown", onKeyDown, true);
}

/**
 * clipboardPasteFrom の本文が WebSocket に書かれるのを待てるようにする。
 *
 * noVNC の clipboardPasteFrom は、拡張クリップボードでは本文をすぐに送らない。
 * Notify を送り、サーバーの Request を受けてから Provide で本文を送る。その前に V を
 * 押すと、相手側の古いクリップボードが貼られる。noVNC はこの完了を知らせないので、
 * RFB に渡す WebSocket の send を包み、出ていく ClientCutText を見て判定する。
 * 拡張でない ClientCutText と Provide は本文を運ぶので、そこで解決する。
 * 文字の範囲は noVNC の制約を受ける。拡張クリップボードなら UTF-8 で、そうでなければ
 * ISO 8859-1 で送られ、その範囲の外の文字 (日本語など) は `?` になる。
 * noVNC はメッセージごとに flush するので、メッセージの先頭は send の先頭に来る。
 *
 * @returns 送られるまで待つ関数と、包みを外す関数
 */
export function trackClipboardDelivery(ws: Pick<WebSocket, "send">): {
  waitForDelivery(send: () => void): Promise<void>;
  stop(): void;
} {
  const original = ws.send;
  let pending: (() => void) | null = null;
  ws.send = function (this: WebSocket, data) {
    if (pending && carriesClipboardText(data)) {
      const resolve = pending;
      pending = null;
      resolve();
    }
    return original.call(this, data);
  } as WebSocket["send"];

  return {
    waitForDelivery(send) {
      return new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          pending = null;
          resolve();
        }, DELIVERY_TIMEOUT_MS);
        pending = () => {
          clearTimeout(timer);
          resolve();
        };
        send();
      });
    },
    stop() {
      ws.send = original;
      pending = null;
    },
  };
}

function carriesClipboardText(data: unknown): boolean {
  // 種別 1 バイト、予備 3 バイト、長さ 4 バイト。空の本文なら 8 バイトで終わる
  if (!(data instanceof Uint8Array) || data.length < 8) return false;
  if (data[0] !== CLIENT_CUT_TEXT) return false;
  // 長さ (符号付き) が負なら拡張クリップボードで、9 バイト目が操作のフラグ
  const extended = (data[4] & 0x80) !== 0;
  return !extended || ((data[8] ?? 0) & EXTENDED_PROVIDE_FLAG) !== 0;
}
