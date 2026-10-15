import { describe, expect, it } from "vitest";
import {
  decideSocketWakeAction,
  SOCKET_WAKE_MIN_INTERVAL_MS,
  type SocketWakeInput,
} from "./socket-wake";

const base: SocketWakeInput = {
  visible: true,
  online: true,
  connected: false,
  lastConnectAttemptAt: 0,
  now: 60_000,
};

describe("decideSocketWakeAction", () => {
  it("切れたまま前面に戻ったら、バックオフを待たずにつなぎ直す", () => {
    expect(decideSocketWakeAction(base)).toBe("reconnect");
  });

  it("つながっているように見えるときは、応答を求めて確かめる", () => {
    expect(decideSocketWakeAction({ ...base, connected: true })).toBe("probe");
  });

  it("背面にいる間は何もしない", () => {
    expect(decideSocketWakeAction({ ...base, visible: false })).toBe("none");
    expect(
      decideSocketWakeAction({ ...base, visible: false, connected: true })
    ).toBe("none");
  });

  it("回線が無いときは online の合図を待つ", () => {
    expect(decideSocketWakeAction({ ...base, online: false })).toBe("none");
  });

  it("接続を始めた直後の合図では、進行中の接続を捨てない", () => {
    const now = 60_000;
    expect(
      decideSocketWakeAction({
        ...base,
        now,
        lastConnectAttemptAt: now - SOCKET_WAKE_MIN_INTERVAL_MS + 1,
      })
    ).toBe("none");
    expect(
      decideSocketWakeAction({
        ...base,
        now,
        lastConnectAttemptAt: now - SOCKET_WAKE_MIN_INTERVAL_MS,
      })
    ).toBe("reconnect");
  });
});
