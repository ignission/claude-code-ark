import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserNotificationTransport,
  deliverSessionNotification,
  isNotificationEnabledForSession,
  readBrowserNotificationApi,
  type SessionAuqSignal,
  SessionNotificationDetector,
  SessionNotificationLeader,
  type SessionStatusSignal,
} from "@/lib/session-notifications";

interface UseSessionNotificationsOptions {
  statusSignals: Map<string, SessionStatusSignal>;
  auqSignals: Map<string, SessionAuqSignal>;
  sessionLabels: Map<string, string>;
  enabledBySession: Record<string, boolean>;
  onOpenSession: (sessionId: string) => void;
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function createTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

export function useSessionNotifications({
  statusSignals,
  auqSignals,
  sessionLabels,
  enabledBySession,
  onOpenSession,
}: UseSessionNotificationsOptions) {
  const detectorRef = useRef(new SessionNotificationDetector());
  const transportRef = useRef(
    new BrowserNotificationTransport(readBrowserNotificationApi())
  );
  const leaderRef = useRef(
    new SessionNotificationLeader(getLocalStorage(), createTabId())
  );
  const [permission, setPermission] = useState(transportRef.current.permission);

  useEffect(() => {
    const leader = leaderRef.current;
    leader.claim();
    const timer = window.setInterval(() => leader.claim(), 2_000);
    return () => {
      window.clearInterval(timer);
      leader.release();
    };
  }, []);

  const dispatch = useCallback(
    (event: {
      sessionId: string;
      kind: "awaiting" | "question" | "completed";
    }) =>
      deliverSessionNotification({
        event,
        sessionLabel: sessionLabels.get(event.sessionId) ?? event.sessionId,
        enabled: isNotificationEnabledForSession(
          enabledBySession,
          event.sessionId
        ),
        transport: transportRef.current,
        isLeader: () => leaderRef.current.claim(),
        focusWindow: () => {
          if (typeof window !== "undefined") window.focus();
        },
        onOpenSession,
      }),
    [enabledBySession, onOpenSession, sessionLabels]
  );

  useEffect(() => {
    for (const signal of statusSignals.values()) {
      const event = detectorRef.current.consumeStatus(signal);
      if (event) dispatch(event);
    }
  }, [dispatch, statusSignals]);

  useEffect(() => {
    for (const signal of auqSignals.values()) {
      const event = detectorRef.current.consumeAuq(signal);
      if (event) dispatch(event);
    }
  }, [auqSignals, dispatch]);

  const requestPermission = useCallback(async () => {
    const next = await transportRef.current.requestPermission();
    setPermission(next);
    return next;
  }, []);

  return {
    supported: transportRef.current.supported,
    permission,
    requestPermission,
  };
}
