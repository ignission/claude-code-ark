import { MessageCircle, Shapes, SquareTerminal } from "lucide-react";
import type { MobileSessionViewMode } from "../lib/mobile-session-view-mode";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";

export const MOBILE_SESSION_VIEW_MODES: readonly SegmentOption<MobileSessionViewMode>[] =
  [
    { value: "chat", label: "会話", icon: MessageCircle },
    { value: "terminal", label: "端末", icon: SquareTerminal },
    { value: "board", label: "図", icon: Shapes },
  ];

interface MobileSessionViewModeToggleProps {
  value: MobileSessionViewMode;
  onChange: (mode: MobileSessionViewMode) => void;
  className?: string;
}

/** モバイルの下部バーの上段に置く「会話 / 端末 / 図」 */
export function MobileSessionViewModeToggle({
  value,
  onChange,
  className,
}: MobileSessionViewModeToggleProps) {
  return (
    <SegmentedControl
      options={MOBILE_SESSION_VIEW_MODES}
      value={value}
      onChange={onChange}
      label="表示モード"
      className={className}
    />
  );
}
