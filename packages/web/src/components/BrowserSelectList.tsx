import { Check } from "lucide-react";
import type React from "react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { type Box, placeSelectList, type Size } from "@/lib/browser-geometry";
import type { BrowserSelectInfo } from "@/lib/browser-session-state";
import { cn } from "@/lib/utils";

interface BrowserSelectListProps {
  select: BrowserSelectInfo;
  /** `<select>` の表示上の矩形。canvasを置く領域の左上から測る */
  anchor: Box;
  /** canvasを置く領域の寸法 */
  area: Size;
  /** `index` は `select.options` の添字 */
  onChoose: (index: number) => void;
  /** 外を押して取り消したときは、その押下のイベントを渡す */
  onCancel: (event?: Event) => void;
}

/** 置く場所を決めるための、中身の高さの見積もり (px)。CSSの行の高さと合わせる */
const OPTION_HEIGHT = 28;
const GROUP_HEIGHT = 22;
const LIST_PADDING = 8;

function firstEnabled(select: BrowserSelectInfo): number {
  return select.options.findIndex(option => !option.disabled);
}

/** はじめに指す選択肢。いまの選択が選べなければ、選べる最初のもの。無ければ -1 */
function initialActive(select: BrowserSelectInfo): number {
  const current = select.options[select.selectedIndex];
  return current && !current.disabled
    ? select.selectedIndex
    : firstEnabled(select);
}

/** `from` から `step` の向きに進んだ、次の選べる選択肢。無ければ `from` のまま */
function nextEnabled(
  select: BrowserSelectInfo,
  from: number,
  step: 1 | -1
): number {
  for (let i = from + step; i >= 0 && i < select.options.length; i += step) {
    if (!select.options[i].disabled) return i;
  }
  return from;
}

/**
 * リモートのページの `<select>` の選択肢。ヘッドレスのChromiumは `<select>` の
 * ポップアップを画面に描かないので、Arkが `<select>` の位置に重ねて描く。
 *
 * 開いている間は、このリストがフォーカスを持ち、キーはリモートへ送らずここで使う
 * (上下の矢印、Home、End、Enter、Escape)。指している選択肢は
 * `aria-activedescendant` で示し、フォーカスはリストから動かさない。無効の選択肢は
 * 飛ばす。`group` は、前の選択肢と違うところに、選べない見出しとして挟む。
 *
 * リストの外を押す、Escape、Tabは取り消し。外を押したかどうかは、文書の全体で聞く
 * (ツールバーを押したときも閉じる)。
 */
export function BrowserSelectList({
  select,
  anchor,
  area,
  onChoose,
  onCancel,
}: BrowserSelectListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [shown, setShown] = useState(select);
  const [active, setActive] = useState(() => initialActive(select));
  if (shown !== select) {
    setShown(select);
    setActive(initialActive(select));
  }
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const optionId = (index: number) => `${baseId}-${index}`;
  const groupCount = select.options.filter(
    (option, index) =>
      option.group !== null && option.group !== select.options[index - 1]?.group
  ).length;
  const placement = placeSelectList(
    anchor,
    area,
    select.options.length * OPTION_HEIGHT +
      groupCount * GROUP_HEIGHT +
      LIST_PADDING
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectは本文中では読まないが、別の選択リストに替わるたびにフォーカスを入れ直すためのtriggerとして依存に入れている
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [select]);

  useEffect(() => {
    const onOutside = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && listRef.current?.contains(target)) return;
      onCancelRef.current(e);
    };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("touchstart", onOutside, true);
    return () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("touchstart", onOutside, true);
    };
  }, []);

  // 指している選択肢が、スクロールで隠れないようにする
  // biome-ignore lint/correctness/useExhaustiveDependencies: optionIdは描くたびに作り直すが、baseIdが同じなら同じ値を返す
  useEffect(() => {
    if (active < 0) return;
    document
      .getElementById(optionId(active))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, baseId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next = active;
    switch (e.key) {
      case "ArrowDown":
        next =
          active < 0 ? firstEnabled(select) : nextEnabled(select, active, 1);
        break;
      case "ArrowUp":
        next =
          active < 0 ? firstEnabled(select) : nextEnabled(select, active, -1);
        break;
      case "Home":
        next = firstEnabled(select);
        break;
      case "End":
        next = nextEnabled(select, select.options.length, -1);
        if (next === select.options.length) next = -1;
        break;
      case "Enter":
      case " ":
        if (active >= 0 && !select.options[active]?.disabled) onChoose(active);
        break;
      case "Escape":
      case "Tab":
        onCancel();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next !== active) setActive(next);
  };

  return (
    <div
      ref={listRef}
      data-browser-overlay
      role="listbox"
      aria-label="選択肢"
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // 押してもフォーカスをリストから動かさない
      onMouseDown={e => e.preventDefault()}
      className="absolute z-30 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-panel outline-none"
      style={{
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        minWidth: placement.minWidth,
        maxWidth: placement.maxWidth,
        maxHeight: placement.maxHeight,
      }}
    >
      {select.options.map((option, index) => {
        const heading =
          option.group !== null &&
          option.group !== select.options[index - 1]?.group
            ? option.group
            : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 選択肢は添字で選ぶもので、並びは開いている間に変わらない
          <Fragment key={index}>
            {heading !== null && (
              <div
                data-select-group
                className="flex h-[22px] items-end truncate px-2.5 text-[11px] text-muted-foreground"
              >
                {heading}
              </div>
            )}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: キーはフォーカスを持つlistboxが受け、指している選択肢をaria-activedescendantで示す */}
            <div
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === select.selectedIndex}
              aria-disabled={option.disabled}
              onClick={() => {
                if (!option.disabled) onChoose(index);
              }}
              onMouseMove={() => {
                if (!option.disabled && active !== index) setActive(index);
              }}
              className={cn(
                "flex h-7 cursor-default items-center gap-1.5 pr-3 whitespace-nowrap",
                option.group !== null ? "pl-4" : "pl-2.5",
                option.disabled && "text-muted-foreground/60",
                index === active && "bg-accent text-accent-foreground"
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {index === select.selectedIndex && (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
