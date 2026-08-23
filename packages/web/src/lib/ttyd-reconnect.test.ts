// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createTtydReconnectState,
  isTtydStuckOverlay,
  stepTtydReconnect,
  TTYD_LOAD_TIMEOUT_MS,
  TTYD_RECOVERY_CONFIRM_MS,
  TTYD_RELOAD_MAX_ATTEMPTS,
  TTYD_RELOAD_MIN_INTERVAL_MS,
} from "./ttyd-reconnect";

/** xterm の term.element を模した DOM を組み立てる */
function buildTermElement(overlayText: string | null): HTMLElement {
  const element = document.createElement("div");
  element.className = "xterm";

  const viewport = document.createElement("div");
  viewport.className = "xterm-viewport";
  element.appendChild(viewport);

  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);

  if (overlayText !== null) {
    // OverlayAddon は class を持たない div を term.element 直下に足す
    const overlay = document.createElement("div");
    overlay.textContent = overlayText;
    element.appendChild(overlay);
  }
  return element;
}

describe("isTtydStuckOverlay", () => {
  it("Enter 待ちの overlay を stuck と判定する", () => {
    expect(isTtydStuckOverlay(buildTermElement("Press ⏎ to Reconnect"))).toBe(
      true
    );
  });

  it("再接続成功直後の 'Reconnected' は stuck ではない", () => {
    // /Reconnect/ だけで判定するとここが true になり、
    // リロード直後にまたリロードする無限ループになる
    expect(isTtydStuckOverlay(buildTermElement("Reconnected"))).toBe(false);
  });

  it("ttyd 自身が再接続中の 'Reconnecting...' は stuck ではない", () => {
    expect(isTtydStuckOverlay(buildTermElement("Reconnecting..."))).toBe(false);
  });

  it("overlay が無ければ stuck ではない", () => {
    expect(isTtydStuckOverlay(buildTermElement(null))).toBe(false);
  });

  it("端末本文に同じ文字列が出ていても stuck とはみなさない", () => {
    const element = buildTermElement(null);
    const screen = element.querySelector(".xterm-screen");
    if (!screen) throw new Error("xterm-screen が無い");
    screen.textContent = "$ echo 'Press ⏎ to Reconnect'";
    expect(isTtydStuckOverlay(element)).toBe(false);
  });

  it("element が無いとき (起動中) は stuck ではない", () => {
    expect(isTtydStuckOverlay(null)).toBe(false);
  });
});

describe("stepTtydReconnect", () => {
  const base = {
    ready: true,
    stuck: true,
    isVisible: true,
    online: true,
    now: 1_000,
  };

  it("停止していればリロードする", () => {
    const r = stepTtydReconnect(createTtydReconnectState(), base);
    expect(r.reload).toBe(true);
    expect(r.state.attempts).toBe(1);
    expect(r.state.lastReloadAt).toBe(1_000);
  });

  it("初回読み込み中 (ready=false かつ未リロード) は何もしない", () => {
    const r = stepTtydReconnect(createTtydReconnectState(), {
      ...base,
      ready: false,
      stuck: false,
    });
    expect(r.reload).toBe(false);
  });

  it("オフラインのあいだは貼り直さず試行回数も消費しない", () => {
    const r = stepTtydReconnect(createTtydReconnectState(), {
      ...base,
      online: false,
    });
    expect(r.reload).toBe(false);
    expect(r.state.attempts).toBe(0);
  });

  it("オンラインに戻ったら貼り直す", () => {
    const offline = stepTtydReconnect(createTtydReconnectState(), {
      ...base,
      online: false,
    });
    const online = stepTtydReconnect(offline.state, { ...base, now: 3_000 });
    expect(online.reload).toBe(true);
  });

  it("貼り直した iframe に xterm が出てこないままなら再度貼り直す", () => {
    const first = stepTtydReconnect(createTtydReconnectState(), base);
    const stillLoading = stepTtydReconnect(first.state, {
      ...base,
      ready: false,
      stuck: false,
      now: base.now + TTYD_LOAD_TIMEOUT_MS - 1,
    });
    expect(stillLoading.reload).toBe(false);

    const timedOut = stepTtydReconnect(first.state, {
      ...base,
      ready: false,
      stuck: false,
      now: base.now + TTYD_LOAD_TIMEOUT_MS,
    });
    expect(timedOut.reload).toBe(true);
    expect(timedOut.state.attempts).toBe(2);
  });

  it("表示されていないペインはリロードしない", () => {
    const r = stepTtydReconnect(createTtydReconnectState(), {
      ...base,
      isVisible: false,
    });
    expect(r.reload).toBe(false);
    expect(r.state.attempts).toBe(0);
  });

  it("表示に戻った時点でリロードする (保留していた分)", () => {
    const hidden = stepTtydReconnect(createTtydReconnectState(), {
      ...base,
      isVisible: false,
    });
    const shown = stepTtydReconnect(hidden.state, { ...base, now: 2_000 });
    expect(shown.reload).toBe(true);
  });

  it("最小間隔内の連続リロードは抑止する", () => {
    const first = stepTtydReconnect(createTtydReconnectState(), base);
    const soon = stepTtydReconnect(first.state, {
      ...base,
      now: base.now + TTYD_RELOAD_MIN_INTERVAL_MS - 1,
    });
    expect(soon.reload).toBe(false);
    expect(soon.state.attempts).toBe(1);

    const later = stepTtydReconnect(first.state, {
      ...base,
      now: base.now + TTYD_RELOAD_MIN_INTERVAL_MS,
    });
    expect(later.reload).toBe(true);
    expect(later.state.attempts).toBe(2);
  });

  it("復帰しないまま上限に達したら諦める", () => {
    let state = createTtydReconnectState();
    let now = base.now;
    for (let i = 0; i < TTYD_RELOAD_MAX_ATTEMPTS; i++) {
      const r = stepTtydReconnect(state, { ...base, now });
      expect(r.reload).toBe(true);
      state = r.state;
      now += TTYD_RELOAD_MIN_INTERVAL_MS;
    }
    const giveUp = stepTtydReconnect(state, { ...base, now });
    expect(giveUp.reload).toBe(false);
    expect(giveUp.exhausted).toBe(true);
  });

  it("リロード直後の非 stuck では試行回数を戻さない (接続中を復帰と誤認しない)", () => {
    const first = stepTtydReconnect(createTtydReconnectState(), base);
    const connecting = stepTtydReconnect(first.state, {
      ...base,
      stuck: false,
      now: base.now + 1_000,
    });
    expect(connecting.state.attempts).toBe(1);
  });

  it("復帰確認時間だけ stuck にならなければ試行回数を戻す", () => {
    const first = stepTtydReconnect(createTtydReconnectState(), base);
    const recovered = stepTtydReconnect(first.state, {
      ...base,
      stuck: false,
      now: base.now + TTYD_RECOVERY_CONFIRM_MS,
    });
    expect(recovered.state.attempts).toBe(0);
    expect(recovered.state.lastReloadAt).toBe(null);
  });
});
