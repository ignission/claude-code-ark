import { describe, expect, it, vi } from "vitest";
import {
  BrowserNotificationTransport,
  buildSessionNotificationPayload,
  deliverSessionNotification,
  isNotificationEnabledForSession,
  type NotificationApiLike,
  type NotificationInstanceLike,
  normalizeSessionNotificationSettings,
  SessionNotificationDetector,
  SessionNotificationLeader,
  type SessionNotificationPayload,
  type SessionNotificationTransport,
  updateSessionNotificationSettings,
} from "./session-notifications";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => Array.from(values.keys())[index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("SessionNotificationDetector", () => {
  it("AWAITINGへの遷移だけを通知し、継続中は重複通知しない", () => {
    const detector = new SessionNotificationDetector();

    expect(
      detector.consumeStatus({ sessionId: "s1", status: "READY", at: 0 })
    ).toBeNull();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 1 })
    ).toEqual({ sessionId: "s1", kind: "awaiting" });
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 2 })
    ).toBeNull();
  });

  it("AWAITINGから離れて戻ったときは再通知する", () => {
    const detector = new SessionNotificationDetector();
    detector.consumeStatus({ sessionId: "s1", status: "READY", at: 0 });
    detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 1 });
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "IDLE", at: 2 })
    ).toBeNull();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 3 })
    ).toEqual({ sessionId: "s1", kind: "awaiting" });
  });

  it.each([
    ["TOOL", "IDLE"],
    ["THINK", "READY"],
    ["THINK", "ERR"],
    ["TOOL", "STOP"],
  ] as const)("実行中 %s から %s への遷移を完了通知にする", (from, to) => {
    const detector = new SessionNotificationDetector();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: from, at: 1 })
    ).toBeNull();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: to, at: 2 })
    ).toEqual({ sessionId: "s1", kind: "completed" });
  });

  it("初回停止状態や実行中から判断待ちへの遷移を完了扱いしない", () => {
    const detector = new SessionNotificationDetector();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "IDLE", at: 1 })
    ).toBeNull();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "TOOL", at: 2 })
    ).toBeNull();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 3 })
    ).toEqual({ sessionId: "s1", kind: "awaiting" });
  });

  it("初回snapshotがAWAITINGでもリロードだけでは通知しない", () => {
    const detector = new SessionNotificationDetector();
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 1 })
    ).toBeNull();
  });

  it("AUQは新しいイベントだけを通知する", () => {
    const detector = new SessionNotificationDetector();
    expect(detector.consumeAuq({ sessionId: "s1", at: 10 })).toEqual({
      sessionId: "s1",
      kind: "question",
    });
    expect(detector.consumeAuq({ sessionId: "s1", at: 10 })).toBeNull();
    expect(detector.consumeAuq({ sessionId: "s1", at: 9 })).toBeNull();
    expect(detector.consumeAuq({ sessionId: "s1", at: 11 })).toEqual({
      sessionId: "s1",
      kind: "question",
    });
  });

  it("AUQ通知の直後に同じ質問由来のAWAITING通知を重ねない", () => {
    const detector = new SessionNotificationDetector();
    expect(detector.consumeAuq({ sessionId: "s1", at: 10 })).toEqual({
      sessionId: "s1",
      kind: "question",
    });
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 11 })
    ).toBeNull();
    detector.consumeStatus({ sessionId: "s1", status: "IDLE", at: 12 });
    expect(
      detector.consumeStatus({ sessionId: "s1", status: "AWAITING", at: 13 })
    ).toEqual({ sessionId: "s1", kind: "awaiting" });
  });
});

describe("notification payload and delivery", () => {
  it.each([
    [
      "awaiting",
      {
        title: "Ark: 判断を待っています",
        body: "ark-notify で権限確認が必要です",
        tag: "ark-session-session-1-awaiting",
      },
    ],
    [
      "question",
      {
        title: "Ark: 質問があります",
        body: "ark-notify が回答を待っています",
        tag: "ark-session-session-1-question",
      },
    ],
    [
      "completed",
      {
        title: "Ark: 作業が完了しました",
        body: "ark-notify の実行が停止しました",
        tag: "ark-session-session-1-completed",
      },
    ],
  ] as const)("%s通知のタイトル・本文・tagを構築する", (kind, expected) => {
    expect(
      buildSessionNotificationPayload(
        { sessionId: "session-1", kind },
        "ark-notify"
      )
    ).toEqual(expected);
  });

  it("transportへ実引数を渡し、クリックで正しいセッションを開く", () => {
    let clickHandler: (() => void) | undefined;
    const show = vi.fn(
      (_payload: SessionNotificationPayload, onClick: () => void) => {
        clickHandler = onClick;
        return true;
      }
    );
    const transport: SessionNotificationTransport = {
      supported: true,
      permission: "granted",
      requestPermission: async () => "granted",
      show,
    };
    const focusWindow = vi.fn();
    const onOpenSession = vi.fn();

    expect(
      deliverSessionNotification({
        event: { sessionId: "session-42", kind: "question" },
        sessionLabel: "feature/payment",
        enabled: true,
        transport,
        isLeader: () => true,
        focusWindow,
        onOpenSession,
      })
    ).toBe(true);
    expect(show).toHaveBeenCalledWith(
      {
        title: "Ark: 質問があります",
        body: "feature/payment が回答を待っています",
        tag: "ark-session-session-42-question",
      },
      expect.any(Function)
    );

    clickHandler?.();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith("session-42");
  });

  it("window focusが拒否されてもクリック先セッションを開く", () => {
    let clickHandler: (() => void) | undefined;
    const transport: SessionNotificationTransport = {
      supported: true,
      permission: "granted",
      requestPermission: async () => "granted",
      show: (_payload, onClick) => {
        clickHandler = onClick;
        return true;
      },
    };
    const onOpenSession = vi.fn();
    deliverSessionNotification({
      event: { sessionId: "session-7", kind: "completed" },
      sessionLabel: "ark-notify",
      enabled: true,
      transport,
      isLeader: () => true,
      focusWindow: () => {
        throw new Error("focus denied");
      },
      onOpenSession,
    });

    expect(() => clickHandler?.()).not.toThrow();
    expect(onOpenSession).toHaveBeenCalledWith("session-7");
  });

  it("セッション設定がoffならtransportを呼ばない", () => {
    const show = vi.fn(() => true);
    const transport: SessionNotificationTransport = {
      supported: true,
      permission: "granted",
      requestPermission: async () => "granted",
      show,
    };
    expect(
      deliverSessionNotification({
        event: { sessionId: "s1", kind: "completed" },
        sessionLabel: "ark-notify",
        enabled: false,
        transport,
        isLeader: () => true,
        focusWindow: vi.fn(),
        onOpenSession: vi.fn(),
      })
    ).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("リーダータブでなければtransportを呼ばない", () => {
    const show = vi.fn(() => true);
    const transport: SessionNotificationTransport = {
      supported: true,
      permission: "granted",
      requestPermission: async () => "granted",
      show,
    };
    deliverSessionNotification({
      event: { sessionId: "s1", kind: "completed" },
      sessionLabel: "ark-notify",
      enabled: true,
      transport,
      isLeader: () => false,
      focusWindow: vi.fn(),
      onOpenSession: vi.fn(),
    });
    expect(show).not.toHaveBeenCalled();
  });
});

describe("BrowserNotificationTransport", () => {
  it("granted時だけNotificationを正しい引数で生成し、クリック後に閉じる", () => {
    const instance: NotificationInstanceLike = {
      onclick: null,
      close: vi.fn(),
    };
    const create = vi.fn(() => instance);
    const api: NotificationApiLike = {
      permission: "granted",
      requestPermission: async () => "granted",
      create,
    };
    const transport = new BrowserNotificationTransport(api);
    const onClick = vi.fn();

    expect(
      transport.show({ title: "Title", body: "Body", tag: "tag-1" }, onClick)
    ).toBe(true);
    expect(create).toHaveBeenCalledWith("Title", {
      body: "Body",
      tag: "tag-1",
      renotify: true,
    });
    instance.onclick?.(new Event("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it.each(["default", "denied"] as const)(
    "%s権限では例外なく無効になる",
    permission => {
      const create = vi.fn();
      const transport = new BrowserNotificationTransport({
        permission,
        requestPermission: async () => permission,
        create,
      });
      expect(
        transport.show({ title: "Title", body: "Body", tag: "tag" }, vi.fn())
      ).toBe(false);
      expect(create).not.toHaveBeenCalled();
    }
  );

  it("Notification APIが無い環境で要求・表示とも例外を投げない", async () => {
    const transport = new BrowserNotificationTransport(null);
    await expect(transport.requestPermission()).resolves.toBe("unsupported");
    expect(
      transport.show({ title: "Title", body: "Body", tag: "tag" }, vi.fn())
    ).toBe(false);
  });

  it("ブラウザ実装が例外を投げてもサイレントに無効化する", async () => {
    const api: NotificationApiLike = {
      permission: "granted",
      requestPermission: async () => {
        throw new Error("blocked");
      },
      create: () => {
        throw new Error("blocked");
      },
    };
    const transport = new BrowserNotificationTransport(api);
    await expect(transport.requestPermission()).resolves.toBe("granted");
    expect(
      transport.show({ title: "Title", body: "Body", tag: "tag" }, vi.fn())
    ).toBe(false);
  });
});

describe("SessionNotificationLeader", () => {
  it("有効なlease中は1タブだけがleaderになり、期限後に交代できる", () => {
    const storage = createMemoryStorage();
    const first = new SessionNotificationLeader(storage, "tab-1", 100);
    const second = new SessionNotificationLeader(storage, "tab-2", 100);

    expect(first.claim(1_000)).toBe(true);
    expect(second.claim(1_050)).toBe(false);
    expect(second.claim(1_101)).toBe(true);
    first.release();
    expect(second.claim(1_102)).toBe(true);
  });
});

describe("normalizeSessionNotificationSettings", () => {
  it("boolean値だけを復元し、未設定セッションは呼び出し側で既定onにできる", () => {
    expect(
      normalizeSessionNotificationSettings({
        enabled: true,
        disabled: false,
        broken: "false",
      })
    ).toEqual({ enabled: true, disabled: false });
    expect(normalizeSessionNotificationSettings(null)).toEqual({});
    expect(isNotificationEnabledForSession({}, "new-session")).toBe(true);
    expect(
      isNotificationEnabledForSession(
        { "muted-session": false },
        "muted-session"
      )
    ).toBe(false);
    expect(
      updateSessionNotificationSettings(
        { existing: true, target: true },
        "target",
        false
      )
    ).toEqual({ existing: true, target: false });
  });
});
