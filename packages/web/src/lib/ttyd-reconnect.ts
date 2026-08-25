/**
 * ttyd が「切断されたまま Enter 待ちで止まっている」状態を検出し、
 * iframe を貼り直して復帰させるための純粋ロジック。
 *
 * ## なぜ必要か
 *
 * モバイル Chrome をバックグラウンドに送ると ttyd への WebSocket が落ちる。
 * ttyd 1.7.4 の `onSocketClose` は
 *
 *   - close code !== 1000 かつ `doReconnect` → 自力で "Reconnecting..." して再接続
 *   - それ以外                               → "Press ⏎ to Reconnect" を出して停止
 *
 * の 2 分岐で、`doReconnect` は WebSocket の error イベントで false になる
 * (`t(u(e,"error",()=>this.doReconnect=!1))`)。回線が切れる経路は error を伴う
 * ため、バックグラウンド復帰は必ず後者（Enter 待ちで停止）に落ちる。
 * ttyd 側の自動再接続はこのケースでは最初から効かない。
 *
 * ## 復帰手段に iframe リロードを選ぶ理由
 *
 * 再接続は iframe 内の Xterm コンポーネントが握っており、window に露出して
 * いるのは xterm の Terminal (`window.term`) だけで socket も connect() も
 * 外から触れない。Enter キーの合成入力は、実は生きている接続に撃つと
 * permission prompt や AskUserQuestion を誤って確定させうるので使わない。
 * iframe リロードは tmux に 1 バイトも送らないので、画面に何が出ていても安全。
 * ttyd 自身の再接続も `terminal.reset()` するので、リロードで失うものは無い。
 */

/**
 * Enter 待ちで停止したときに ttyd が overlay へ出す文言 (ttyd 1.7.4 `onSocketClose`)。
 *
 * overlay は "Reconnecting..." / "Reconnected" / "80x24" / "✂" にも使い回される。
 * 特に "Reconnected" は再接続成功の表示なので、`/Reconnect/` だけで判定すると
 * リロード直後に再び stuck と誤判定して無限リロードになる。
 */
const STUCK_OVERLAY_PATTERN = /Press\s.*Reconnect/;

/** 自動リロードの最小間隔 (ms) */
export const TTYD_RELOAD_MIN_INTERVAL_MS = 5_000;

/** 復帰を確認できないまま繰り返す自動リロードの上限 */
export const TTYD_RELOAD_MAX_ATTEMPTS = 3;

/** リロード後この時間 stuck にならなければ復帰とみなし、試行回数を戻す (ms) */
export const TTYD_RECOVERY_CONFIRM_MS = 10_000;

/** リロード後この時間 画面が届かなければ読み込み失敗・handshake 保留とみなす (ms) */
export const TTYD_LOAD_TIMEOUT_MS = 10_000;

/**
 * xterm の `term.element` を見て、ttyd が Enter 待ちで止まっているかを判定する。
 *
 * OverlayAddon は class を持たない div を `term.element` 直下へ append する。
 * 端末本文 (.xterm-*) に同じ文字列が表示されていても拾わないよう、
 * xterm 自身の子要素は除外する。
 */
export function isTtydStuckOverlay(
  termElement: Element | null | undefined
): boolean {
  if (!termElement) return false;
  for (const child of Array.from(termElement.children)) {
    const className =
      typeof child.className === "string" ? child.className : "";
    if (className.includes("xterm")) continue;
    if (STUCK_OVERLAY_PATTERN.test(child.textContent ?? "")) return true;
  }
  return false;
}

/**
 * xterm のバッファに何か描画されているか。
 *
 * 「stuck overlay が出ていない」だけでは接続できたことにならない。iframe を
 * 貼り直した直後や、パケットが落ちるだけで RST が返らない回線では、xterm は
 * 出来ているのに WebSocket の handshake が延々と保留になる。この状態を復帰と
 * 誤認すると試行回数が戻ってしまい、上限が効かなくなる (codex review 指摘)。
 *
 * 接続できていれば tmux が画面を描き直すので、バッファに文字が入ることを
 * 「繋がった」の肯定的な証拠として使う。空の判定は保守的側 (繋がっていない扱い)
 * に倒れるので、誤っても暴走はしない。
 */
export function hasTerminalOutput(term: XtermLike | null | undefined): boolean {
  const buffer = term?.buffer?.active;
  if (!buffer) return false;
  const rows = Math.min(term?.rows ?? 0, buffer.length ?? 0);
  // 先頭から数行見れば足りる (繋がっていれば 1 行目から埋まる)
  const limit = Math.min(rows, 24);
  for (let y = 0; y < limit; y++) {
    if ((buffer.getLine(y)?.translateToString(true) ?? "").trim() !== "") {
      return true;
    }
  }
  return false;
}

/** `window.term` (xterm.js の Terminal) のうち、ここで使う部分だけ */
export interface XtermLike {
  rows?: number;
  buffer?: {
    active?: {
      length?: number;
      getLine(
        y: number
      ): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

export interface TtydReconnectState {
  /** 復帰を確認できていない連続自動リロード回数 */
  attempts: number;
  /** 直近に自動リロードした時刻 (ms)。未リロードなら null */
  lastReloadAt: number | null;
}

export function createTtydReconnectState(): TtydReconnectState {
  return { attempts: 0, lastReloadAt: null };
}

export interface TtydReconnectInput {
  /** WebSocket が繋がって画面が届いているか (xterm 未生成・handshake 保留は false) */
  connected: boolean;
  /** Enter 待ちで停止しているか */
  stuck: boolean;
  /** ターミナルが実際に画面へ出ているか */
  isVisible: boolean;
  /** ブラウザがオンラインか (`navigator.onLine`) */
  online: boolean;
  now: number;
}

export interface TtydReconnectStep {
  state: TtydReconnectState;
  /** iframe を貼り直すべきか */
  reload: boolean;
  /** 上限まで試して復帰しなかったか (以後は手動リロードに委ねる) */
  exhausted: boolean;
}

/**
 * 1 回ぶんの観測から、iframe を貼り直すかどうかを決める。
 *
 * - 表示されていないペインはリロードしない。隠れた iframe を貼り直すと
 *   ttyd の `fitAddon.fit()` がサイズ 0 に対して走り、次の resize まで
 *   端末が歪んだままになる。表示に戻った次の観測でリロードする
 * - 復帰の確認は「画面が届いている状態が `TTYD_RECOVERY_CONFIRM_MS` 続くこと」。
 *   stuck でないだけでは handshake 保留と区別できず、試行回数の上限が効かなくなる
 * - オフラインのあいだは貼り直さない。回線が戻る前にリロードすると
 *   iframe が読み込み失敗のまま残り、xterm が現れないので次の検出もできない
 */
export function stepTtydReconnect(
  state: TtydReconnectState,
  input: TtydReconnectInput
): TtydReconnectStep {
  const { connected, stuck, isVisible, online, now } = input;
  const sinceReload =
    state.lastReloadAt === null ? null : now - state.lastReloadAt;

  if (!stuck && connected) {
    // 繋がった状態が `TTYD_RECOVERY_CONFIRM_MS` 続いたら復帰とみなす。
    // 直後に戻さないのは、貼り直した直後の一瞬を復帰と誤認しないため
    if (sinceReload !== null && sinceReload >= TTYD_RECOVERY_CONFIRM_MS) {
      return {
        state: createTtydReconnectState(),
        reload: false,
        exhausted: false,
      };
    }
    return { state, reload: false, exhausted: false };
  }

  // 貼り直したのに画面が来ない = 読み込み失敗か handshake が保留のまま
  // (回線が戻る前に貼り直した場合など)。時間切れでもう一度貼り直す
  const stalled =
    !connected && sinceReload !== null && sinceReload >= TTYD_LOAD_TIMEOUT_MS;
  if (!stuck && !stalled) return { state, reload: false, exhausted: false };

  if (!isVisible) return { state, reload: false, exhausted: false };

  // 回線が切れているうちに貼り直しても白い iframe が残るだけなので、
  // オンラインに戻るまで待つ (試行回数も消費しない)
  if (!online) return { state, reload: false, exhausted: false };

  if (state.attempts >= TTYD_RELOAD_MAX_ATTEMPTS) {
    return { state, reload: false, exhausted: true };
  }

  const throttled =
    sinceReload !== null && sinceReload < TTYD_RELOAD_MIN_INTERVAL_MS;
  if (throttled) return { state, reload: false, exhausted: false };

  return {
    state: { attempts: state.attempts + 1, lastReloadAt: now },
    reload: true,
    exhausted: false,
  };
}
