import { Bell, BellOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/lib/i18n";

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
    ? m.session.browserNotifications.granted
    : denied
      ? m.session.browserNotifications.denied
      : m.session.browserNotifications.enable;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      disabled={requesting || denied || granted}
      onClick={async () => {
        setRequesting(true);
        try {
          await onRequestPermission();
        } finally {
          setRequesting(false);
        }
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
