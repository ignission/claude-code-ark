import { Check } from "lucide-react";
import type React from "react";
import {
  Fragment,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type Box,
  placeSelectList,
  SELECT_GROUP_HEIGHT,
  SELECT_LIST_PADDING,
  SELECT_OPTION_HEIGHT,
  type Size,
} from "@/lib/browser-geometry";
import type { BrowserSelectInfo } from "@/lib/browser-session-state";
import { cn } from "@/lib/utils";

interface BrowserSelectListProps {
  select: BrowserSelectInfo;
  /** `<select>` の表示上の矩形。canvasを置く領域の左上から測る */
  anchor: Box;
  /** canvasを置く領域の寸法 */
  area: Size;
  /**
   * 出たときにフォーカスを取ってよいか。フォーカスを動かす直前に呼ぶ。渡さなければ取る
   */
  shouldTakeFocus?: () => boolean;
  /** `index` は `select.options` の添字 */
  onChoose: (index: number) => void;
  /** 外を押して取り消したときは、その押下のイベントを渡す */
  onCancel: (event?: Event) => void;
}

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

interface OptionRowProps {
  id: string;
  index: number;
  label: string;
  disabled: boolean;
  grouped: boolean;
  /** キーで指している選択肢か (Enterで選ばれる) */
  active: boolean;
  /** ページのいまの選択か */
  current: boolean;
}

/**
 * 選択肢の1行。渡す値はどれも文字列か真偽値なので、指す選択肢が動いても、描き直すのは
 * 前に指していた行と、新しく指した行だけ。
 */
const OptionRow = memo(function OptionRow({
  id,
  index,
  label,
  disabled,
  grouped,
  active,
  current,
}: OptionRowProps) {
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      data-index={index}
      aria-selected={active}
      aria-disabled={disabled}
      className={cn(
        "flex h-7 cursor-default items-center gap-1.5 pr-3 whitespace-nowrap",
        grouped ? "pl-4" : "pl-2.5",
        disabled ? "text-muted-foreground/60" : "hover:bg-accent/60",
        active && "bg-accent text-accent-foreground hover:bg-accent"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {current && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
    </div>
  );
});

/**
 * リモートのページの `<select>` の選択肢。ヘッドレスのChromiumは `<select>` の
 * ポップアップを画面に描かないので、Arkが `<select>` の位置に重ねて描く。
 *
 * フォーカスを取るかどうかは親が決める (`shouldTakeFocus`)。この視聴者の操作で開いた
 * リストはフォーカスを取り、キーはリモートへ送らずここで使う (上下の矢印、Home、End、
 * Enter、Escape)。ほかの視聴者の操作で開いたリストは、フォーカスを取らない (打っている
 * 途中のキーを奪わない)。その間も、押せば選べる。
 *
 * キーで指している選択肢 (Enterで選ばれるもの) は、`aria-activedescendant` と
 * `aria-selected` で示し、フォーカスはリストから動かさない。ページのいまの選択は、
 * チェックの印で示す。無効の選択肢は飛ばす。`group` は、前の選択肢と違うところに、
 * 選べない見出しとして挟む。
 *
 * マウスを載せた行の色はCSSで付け、指している選択肢は動かさない。選択肢が千を超える
 * リストでも、マウスを動かすたびに全部の行を描き直さないようにする。押下は、行ごとでは
 * なくリストで受け、押された行を `data-index` で見分ける。
 *
 * リストの外を押す、Escape、Tabは取り消し。外を押したかどうかは、文書の全体で聞く
 * (ツールバーを押したときも閉じる)。
 */
export function BrowserSelectList({
  select,
  anchor,
  area,
  shouldTakeFocus,
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
  // 文書に付けたリスナーから、いまの `onCancel` を呼ぶ
  const onCancelRef = useRef(onCancel);
  useLayoutEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  const optionId = (index: number) => `${baseId}-${index}`;
  const groupCount = select.options.filter(
    (option, index) =>
      option.group !== null && option.group !== select.options[index - 1]?.group
  ).length;
  const placement = placeSelectList(
    anchor,
    area,
    select.options.length * SELECT_OPTION_HEIGHT +
      groupCount * SELECT_GROUP_HEIGHT +
      SELECT_LIST_PADDING
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectは本文中では読まないが、別の選択リストに替わるたびにフォーカスを入れ直すためのtriggerとして依存に入れている。shouldTakeFocusは、その時点の1回だけ呼ぶ
  useEffect(() => {
    if (shouldTakeFocus && !shouldTakeFocus()) return;
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

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-index]");
    const index = Number(row?.dataset.index ?? -1);
    const option = select.options[index];
    if (option && !option.disabled) onChoose(index);
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
      onClick={handleClick}
      // 押してもフォーカスを動かさない
      onMouseDown={e => e.preventDefault()}
      className="absolute z-20 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-panel outline-none"
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
                role="presentation"
                className="flex h-[22px] items-end truncate px-2.5 text-[11px] text-muted-foreground"
              >
                {heading}
              </div>
            )}
            <OptionRow
              id={optionId(index)}
              index={index}
              label={option.label}
              disabled={option.disabled}
              grouped={option.group !== null}
              active={index === active}
              current={index === select.selectedIndex}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
