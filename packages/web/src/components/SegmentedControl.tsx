/**
 * SegmentedControl - 表示の切り替え
 *
 * PC上部バーの「端末 / 会話」と、モバイル下部バーの「会話 / 端末 / 図」で使う。
 * 選択中の項目を白いカプセル (bg-card + shadow-card) で持ち上げる。
 * 各項目はaria-pressedを持つトグルボタンで、選択の状態は親が持つ。
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon: LucideIcon;
}

interface SegmentedControlProps<V extends string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** まとまりの読み上げ名 (例: 「左ペインの表示」)。画面には出さない */
  label?: string;
  className?: string;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<V>) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-md border-0 bg-muted p-0.5 dark:bg-background",
        className
      )}
    >
      {label && <legend className="sr-only">{label}</legend>}
      {options.map(option => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-3.5 text-[13px] font-semibold transition-colors",
              selected
                ? "bg-card text-foreground shadow-card"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
