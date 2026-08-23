/**
 * PC 左ペインの表示モード切替（端末 / 会話）。
 *
 * SplitViewPane 上部バーの左端に置く。右端の 📐（右ペイン開閉）とは
 * 独立した状態で、両方を同時に選べる（例: 会話 + 図の左右 2 ペイン）。
 */

import type { SplitViewLeftMode } from "../lib/split-view-left-mode";

export const SPLIT_VIEW_LEFT_MODES: ReadonlyArray<{
  value: SplitViewLeftMode;
  icon: string;
  label: string;
}> = [
  { value: "terminal", icon: "🖥", label: "端末" },
  { value: "chat", icon: "💬", label: "会話" },
];

interface SplitViewLeftModeToggleProps {
  value: SplitViewLeftMode;
  onChange: (mode: SplitViewLeftMode) => void;
}

export function SplitViewLeftModeToggle({
  value,
  onChange,
}: SplitViewLeftModeToggleProps) {
  return (
    <fieldset className="flex items-center rounded-md border-0 bg-muted p-0.5 shrink-0">
      <legend className="sr-only">左ペインの表示</legend>
      {SPLIT_VIEW_LEFT_MODES.map(option => {
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
