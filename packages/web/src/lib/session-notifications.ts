import type { BridgeSessionStatus } from "@ark/shared";

export type SessionNotificationKind = "awaiting" | "question" | "completed";

export interface SessionStatusSignal {
  sessionId: string;
  status: BridgeSessionStatus;
  at: number;
}

export interface SessionAuqSignal {
  sessionId: string;
  at: number;
}

export interface SessionNotificationEvent {
  sessionId: string;
  kind: SessionNotificationKind;
}

export interface SessionNotificationPayload {
  title: string;
  body: string;
  tag: string;
}

export interface NotificationInstanceLike {
  onclick: ((event: Event) => unknown) | null;
  close: () => void;
}

/** TypeScript 6.0のlib.domに未収録だがNotifications API標準にあるoption。 */
export type BrowserNotificationOptions = NotificationOptions & {
  renotify?: boolean;
};

export interface NotificationApiLike {
  readonly permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  create: (
    title: string,
    options: BrowserNotificationOptions
  ) => NotificationInstanceLike;
}

export interface SessionNotificationTransport {
  readonly supported: boolean;
  readonly permission: NotificationPermission | "unsupported";
  requestPermission: () => Promise<NotificationPermission | "unsupported">;
  show: (payload: SessionNotificationPayload, onClick: () => void) => boolean;
}

const RUNNING_STATUSES = new Set<BridgeSessionStatus>(["TOOL", "THINK"]);
const COMPLETED_STATUSES = new Set<BridgeSessionStatus>([
  "IDLE",
  "READY",
  "ERR",
  "STOP",
]);

/**
 * Socket signalsから通知条件だけを判定する状態機械。
 * Notification APIには依存しないため、将来Web Push transportでも再利用できる。
 */
export class SessionNotificationDetector {
  private readonly statusBySession = new Map<string, BridgeSessionStatus>();
  private readonly lastAuqAtBySession = new Map<string, number>();
  private readonly activeAuqSessions = new Set<string>();

  consumeStatus(signal: SessionStatusSignal): SessionNotificationEvent | null {
    const previous = this.statusBySession.get(signal.sessionId);
    this.statusBySession.set(signal.sessionId, signal.status);

    if (previous === signal.status) return null;
    if (signal.status !== "AWAITING") {
      this.activeAuqSessions.delete(signal.sessionId);
    }
    // 初回snapshotは現在値の初期化。リロードだけで既存の待機状態を再通知しない。
    if (previous === undefined) return null;
    if (signal.status === "AWAITING") {
      // AUQは専用イベントの方が具体的なので、同じ質問にAWAITING通知を重ねない。
      if (this.activeAuqSessions.has(signal.sessionId)) return null;
      return { sessionId: signal.sessionId, kind: "awaiting" };
    }
    if (
      previous !== undefined &&
      RUNNING_STATUSES.has(previous) &&
      COMPLETED_STATUSES.has(signal.status)
    ) {
      return { sessionId: signal.sessionId, kind: "completed" };
    }
    return null;
  }

  consumeAuq(signal: SessionAuqSignal): SessionNotificationEvent | null {
    const previousAt = this.lastAuqAtBySession.get(signal.sessionId);
    if (previousAt !== undefined && signal.at <= previousAt) return null;
    this.lastAuqAtBySession.set(signal.sessionId, signal.at);
    this.activeAuqSessions.add(signal.sessionId);
    return { sessionId: signal.sessionId, kind: "question" };
  }
}

export function readBrowserNotificationApi(): NotificationApiLike | null {
  if (typeof Notification === "undefined") return null;
  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    create: (title, options) => new Notification(title, options),
  };
}

export class BrowserNotificationTransport
  implements SessionNotificationTransport
{
  constructor(private readonly api: NotificationApiLike | null) {}

  get supported(): boolean {
    return this.api !== null;
  }

  get permission(): NotificationPermission | "unsupported" {
    return this.api?.permission ?? "unsupported";
  }

  async requestPermission(): Promise<NotificationPermission | "unsupported"> {
    if (!this.api) return "unsupported";
    try {
      return await this.api.requestPermission();
    } catch {
      return this.api.permission;
    }
  }

  show(payload: SessionNotificationPayload, onClick: () => void): boolean {
    if (this.api?.permission !== "granted") return false;
    try {
      const notification = this.api.create(payload.title, {
        body: payload.body,
        tag: payload.tag,
        renotify: true,
      });
      notification.onclick = () => {
        try {
          onClick();
        } finally {
          notification.close();
        }
      };
      return true;
    } catch {
      return false;
    }
  }
}

export function buildSessionNotificationPayload(
  event: SessionNotificationEvent,
  sessionLabel: string
): SessionNotificationPayload {
  switch (event.kind) {
    case "awaiting":
      return {
        title: "Ark: 判断を待っています",
        body: `${sessionLabel} で権限確認が必要です`,
        tag: `ark-session-${event.sessionId}-awaiting`,
      };
    case "question":
      return {
        title: "Ark: 質問があります",
        body: `${sessionLabel} が回答を待っています`,
        tag: `ark-session-${event.sessionId}-question`,
      };
    case "completed":
      return {
        title: "Ark: 作業が完了しました",
        body: `${sessionLabel} の実行が停止しました`,
        tag: `ark-session-${event.sessionId}-completed`,
      };
  }
}

export function deliverSessionNotification(args: {
  event: SessionNotificationEvent;
  sessionLabel: string;
  enabled: boolean;
  transport: SessionNotificationTransport;
  isLeader: () => boolean;
  onOpenSession: (sessionId: string) => void;
  focusWindow: () => void;
}): boolean {
  if (!args.enabled || !args.isLeader()) return false;
  return args.transport.show(
    buildSessionNotificationPayload(args.event, args.sessionLabel),
    () => {
      try {
        args.focusWindow();
      } catch {
        // focusがブラウザに拒否されてもセッション遷移は続ける。
      }
      args.onOpenSession(args.event.sessionId);
    }
  );
}

export function normalizeSessionNotificationSettings(
  value: unknown
): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
    )
  );
}

export function isNotificationEnabledForSession(
  settings: Record<string, boolean>,
  sessionId: string
): boolean {
  return settings[sessionId] !== false;
}

export function updateSessionNotificationSettings(
  settings: Record<string, boolean>,
  sessionId: string,
  enabled: boolean
): Record<string, boolean> {
  return { ...settings, [sessionId]: enabled };
}

interface LeaderLease {
  tabId: string;
  expiresAt: number;
}

const LEADER_STORAGE_KEY = "ark-session-notification-leader";

/** localStorageの同期性を使ったbest-effortな複数タブリーダー選出。 */
export class SessionNotificationLeader {
  constructor(
    private readonly storage: Storage | null,
    private readonly tabId: string,
    private readonly leaseMs = 5_000
  ) {}

  claim(now = Date.now()): boolean {
    if (!this.storage) return true;
    try {
      const current = this.readLease();
      if (current && current.tabId !== this.tabId && current.expiresAt > now) {
        return false;
      }
      const next: LeaderLease = {
        tabId: this.tabId,
        expiresAt: now + this.leaseMs,
      };
      this.storage.setItem(LEADER_STORAGE_KEY, JSON.stringify(next));
      return this.readLease()?.tabId === this.tabId;
    } catch {
      return true;
    }
  }

  release(): void {
    if (!this.storage) return;
    try {
      if (this.readLease()?.tabId === this.tabId) {
        this.storage.removeItem(LEADER_STORAGE_KEY);
      }
    } catch {
      // Storageが利用不能でも通知機能自体は壊さない。
    }
  }

  private readLease(): LeaderLease | null {
    if (!this.storage) return null;
    const raw = this.storage.getItem(LEADER_STORAGE_KEY);
    if (!raw) return null;
    let value: Partial<LeaderLease>;
    try {
      value = JSON.parse(raw) as Partial<LeaderLease>;
    } catch {
      return null;
    }
    if (
      typeof value.tabId !== "string" ||
      typeof value.expiresAt !== "number"
    ) {
      return null;
    }
    return { tabId: value.tabId, expiresAt: value.expiresAt };
  }
}
