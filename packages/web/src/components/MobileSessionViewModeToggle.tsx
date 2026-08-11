import type { MobileSessionViewMode } from "../lib/mobile-session-view-mode";

export const MOBILE_SESSION_VIEW_MODES: ReadonlyArray<{
  value: MobileSessionViewMode;
  icon: string;
  label: string;
}> = [
  { value: "chat", icon: "💬", label: "会話" },
  { value: "terminal", icon: "🖥", label: "端末" },
  { value: "board", icon: "📐", label: "図" },
];

interface MobileSessionViewModeToggleProps {
  value: MobileSessionViewMode;
  onChange: (mode: MobileSessionViewMode) => void;
}

export function MobileSessionViewModeToggle({
  value,
  onChange,
}: MobileSessionViewModeToggleProps) {
  return (
    <fieldset className="flex items-center rounded-md border-0 bg-muted p-0.5 shrink-0">
      <legend className="sr-only">表示モード</legend>
      {MOBILE_SESSION_VIEW_MODES.map(option => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-0.5 rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span aria-hidden="true">{option.icon}</span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
