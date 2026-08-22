import { Bell, BellOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface NotificationPermissionButtonProps {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  onRequestPermission: () => Promise<NotificationPermission | "unsupported">;
  className?: string;
}

export function NotificationPermissionButton({
  supported,
  permission,
  onRequestPermission,
  className = "h-8 w-8",
}: NotificationPermissionButtonProps) {
  const [requesting, setRequesting] = useState(false);
  if (!supported || permission === "unsupported") return null;

  const denied = permission === "denied";
  const granted = permission === "granted";
  const label = granted
    ? "ブラウザ通知は許可済み"
    : denied
      ? "ブラウザ通知はブラウザ設定で拒否されています"
      : "ブラウザ通知を有効にする";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      disabled={requesting || denied || granted}
      onClick={async () => {
        setRequesting(true);
        await onRequestPermission();
        setRequesting(false);
      }}
      aria-label={label}
      title={label}
    >
      {requesting ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : denied ? (
        <BellOff className="w-4 h-4" />
      ) : (
        <Bell className="w-4 h-4" />
      )}
    </Button>
  );
}
