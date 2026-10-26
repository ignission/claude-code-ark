import type { MobileSessionViewMode } from "../lib/mobile-session-view-mode";
import { VIEW_MODE_ICONS } from "../lib/view-mode-icons";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";

export const MOBILE_SESSION_VIEW_MODES: readonly SegmentOption<MobileSessionViewMode>[] =
  [
    { value: "chat", label: "会話", icon: VIEW_MODE_ICONS.chat },
    { value: "board", label: "図", icon: VIEW_MODE_ICONS.board },
    { value: "todo", label: "TODO", icon: VIEW_MODE_ICONS.todo },
  ];

interface MobileSessionViewModeToggleProps {
  value: MobileSessionViewMode;
  onChange: (mode: MobileSessionViewMode) => void;
  className?: string;
}

/** モバイルの下部バーの上段に置く「会話 / 図 / TODO」。端末はモードではなく、会話の帯から窓で開く */
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
