import { useCallback, useEffect, useRef, useState } from "react";

type SettingsState = Record<string, unknown>;

const API_BASE = "/api/settings";
const DEBOUNCE_MS = 300;

/**
 * サーバー側のsettingsテーブルと同期するフック
 *
 * - 初回マウント時にGET /api/settingsで全設定を取得
 * - setSetting()で変更するとdebounce付きでサーバーに保存
 * - localStorageは使用しない
 */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsState>({});
  const [isLoading, setIsLoading] = useState(true);
  const pendingRef = useRef<Map<string, unknown>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<SettingsState>({});

  // 初回マウント時に全設定を取得
  useEffect(() => {
    fetch(API_BASE)
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch settings");
        return res.json();
      })
      .then((data: SettingsState) => {
        settingsRef.current = data;
        setSettings(data);
        setIsLoading(false);
      })
      .catch(() => {
        setIsLoading(false);
      });
  }, []);

  // debounce付きでサーバーに保存
  const flushToServer = useCallback(() => {
    const entries = Object.fromEntries(pendingRef.current);
    if (Object.keys(entries).length === 0) return;

    fetch(API_BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    })
      .then(res => {
        if (res.ok) {
          for (const key of Object.keys(entries)) {
            // flush中に新しい値が書き込まれていない場合のみ削除
            if (pendingRef.current.get(key) === entries[key]) {
              pendingRef.current.delete(key);
            }
          }
        }
      })
      .catch(() => {
        // サーバーエラー時はサイレントに失敗（次回リロード時にサーバーの値を使用）
      });
  }, []);

  const setSetting = useCallback(
    (key: string, value: unknown) => {
      settingsRef.current = { ...settingsRef.current, [key]: value };
      setSettings(prev => ({ ...prev, [key]: value }));
      pendingRef.current.set(key, value);

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(flushToServer, DEBOUNCE_MS);
    },
    [flushToServer]
  );

  const getSetting = useCallback(<T>(key: string, defaultValue: T): T => {
    const value = settingsRef.current[key];
    return value !== undefined ? (value as T) : defaultValue;
  }, []);

  // アンマウント時にpending分をフラッシュ
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (pendingRef.current.size > 0) {
        const entries = Object.fromEntries(pendingRef.current);
        // keepalive: true でページ離脱時にも確実にPUTリクエストを送信
        fetch(API_BASE, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entries),
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, []);

  return { settings, isLoading, getSetting, setSetting };
}
