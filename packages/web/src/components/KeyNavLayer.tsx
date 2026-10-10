/**
 * KeyNavLayer - Ark を vim 風のキーで動かす層 (PC のみ)
 *
 * 入力モード (既定。キーは端末や入力欄にそのまま入る) とノーマルモード (キーは Ark への
 * 指示になる) を持つ。前置キー (Ctrl+;) で行き来し、ノーマルモードでは `i` でも入力へ戻る。
 * キーの解釈は lib/keynav.ts、画面の操作は lib/keynav-dom.ts。
 *
 * - ノーマルモードに入るとき、フォーカスを端末の iframe や入力欄から受け皿 (見えない
 *   要素) へ移す。iframe にフォーカスが残ると、キーが親の window に届かない
 * - 入力欄や端末をクリックしたら、入力モードに戻す (表示と実際の食い違いを残さない)
 * - ダイアログやメニューが開いている間は何もしない (そちらのキー操作を邪魔しない)
 * - いる場所とモードは <html> の属性に出し、枠は index.css が描く
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { KEYNAV_LEADER_EVENT } from "@/hooks/useTerminalLeaderKey";
import {
  isLeaderKey,
  KEYNAV_HELP,
  type KeyNavCommand,
  type KeyNavRegion,
  resolveKey,
} from "@/lib/keynav";
import {
  availableRegions,
  executeKeyNavCommand,
  focusInput,
  regionFocusTarget,
} from "@/lib/keynav-dom";
import {
  PALETTE_CLOSED_EVENT,
  PALETTE_OPEN_EVENT,
  type PaletteClosedDetail,
} from "@/lib/palette";

type Mode = "insert" | "normal";

const REGION_LABEL: Record<KeyNavRegion, string> = {
  sidebar: "サイドバー",
  left: "左のパネル",
  work: "作業エリア",
};

/** 場所を替えた直後は移り先がまだ描かれていないことがあるので、少し待って探し直す */
const REFOCUS_DELAYS_MS = [0, 120, 400];

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // パレットの入力欄はノーマルモードの中で開くものなので、入力モードへ戻す合図にしない
  if (target.closest("[data-keynav-ignore]")) return false;
  if (target.isContentEditable || target.closest(".cm-editor")) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit"].includes(
      target.type
    );
  }
  return false;
}

/** ダイアログやメニューが開いているか (キーの一覧は数えない) */
function overlayOpen(): boolean {
  return [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="menu"]'
    ),
  ].some(el => !el.hasAttribute("data-keynav-help"));
}

export function KeyNavLayer() {
  const [mode, setMode] = useState<Mode>("insert");
  const [region, setRegion] = useState<KeyNavRegion>("left");
  const [pending, setPending] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const sinkRef = useRef<HTMLDivElement>(null);
  // リスナーを張り直さずに最新の値を読む
  const stateRef = useRef({ mode, region, pending, helpOpen });
  stateRef.current = { mode, region, pending, helpOpen };
  const timersRef = useRef<number[]>([]);
  const deferredRef = useRef<number | undefined>(undefined);

  const cancelRefocus = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const focusRegion = useCallback(
    (target: KeyNavRegion) => {
      cancelRefocus();
      timersRef.current = REFOCUS_DELAYS_MS.map(delay =>
        window.setTimeout(() => {
          if (stateRef.current.mode !== "normal") return;
          if (stateRef.current.region !== target) return;
          // 置き直しを待つ間に開いたパレットやダイアログから、フォーカスを奪わない
          if (overlayOpen()) return;
          const element = regionFocusTarget(document, target);
          // 置き先が無い場所 (会話・図) では受け皿に置き、キーが親の window に届くようにする
          (element ?? sinkRef.current)?.focus({
            preventScroll: element === null,
          });
          // 置けたら探し直しをやめる (置いたあとに j / k で動かした先から、引き戻さない)
          if (element) cancelRefocus();
        }, delay)
      );
    },
    [cancelRefocus]
  );

  const enterNormal = useCallback(
    (from?: KeyNavRegion) => {
      // 作業エリアを閉じたあとなど、覚えている場所がもう無ければ左のパネルに戻す
      const regions = availableRegions(document);
      const wanted = from ?? stateRef.current.region;
      const next = regions.includes(wanted) ? wanted : "left";
      stateRef.current = { ...stateRef.current, mode: "normal", region: next };
      setMode("normal");
      setRegion(next);
      setPending("");
      sinkRef.current?.focus({ preventScroll: true });
      focusRegion(next);
    },
    [focusRegion]
  );

  const exitToInsert = useCallback(() => {
    stateRef.current = { ...stateRef.current, mode: "insert" };
    setMode("insert");
    setPending("");
    setHelpOpen(false);
    focusInput(document);
  }, []);

  const run = useCallback(
    (command: KeyNavCommand) => {
      if (command.type === "help") {
        setHelpOpen(open => !open);
        return;
      }
      if (command.type === "cancel") {
        setHelpOpen(false);
        return;
      }
      if (command.type === "palette") {
        setHelpOpen(false);
        window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
        return;
      }
      // 次の指示が来たら、前の指示のフォーカスの置き直しと、後回しにした操作は捨てる
      // (閉じた作業エリアで gd の直後に gf を打ったとき、遅れた gd が gf を上書きしない)
      cancelRefocus();
      window.clearTimeout(deferredRef.current);
      // セッションを替えた先で作業エリアが閉じているなど、いた場所がもう無ければ
      // 左のパネルにいることにする (無い場所のままだと h でも出られない)
      const from = availableRegions(document).includes(stateRef.current.region)
        ? stateRef.current.region
        : "left";
      const result = executeKeyNavCommand(
        command,
        from,
        document,
        document,
        fn => {
          deferredRef.current = window.setTimeout(() => {
            fn();
            // 後回しにした操作で中身が替わるので、フォーカスを置き直す
            // (先に置いた、替わる前のタブの中身に残さない)
            if (stateRef.current.mode === "normal") {
              focusRegion(stateRef.current.region);
            }
          }, 60);
        }
      );
      if (result.insert) {
        stateRef.current = { ...stateRef.current, mode: "insert" };
        setMode("insert");
        setHelpOpen(false);
        return;
      }
      if (result.region !== stateRef.current.region) {
        stateRef.current = { ...stateRef.current, region: result.region };
        setRegion(result.region);
      }
      if (result.refocus) focusRegion(result.region);
    },
    [cancelRefocus, focusRegion]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 変換の確定に使うキーは横取りしない
      if (event.isComposing) return;
      // ダイアログやメニューが開いている間は、前置キーも含めて何もしない
      // (フォーカスを外へ移すと、そちらのキー操作を壊す)
      if (overlayOpen()) return;
      if (isLeaderKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (stateRef.current.mode === "normal") exitToInsert();
        else enterNormal();
        return;
      }
      if (stateRef.current.mode !== "normal") return;
      const resolved = resolveKey(stateRef.current.pending, event);
      if (!resolved.handled) return;
      event.preventDefault();
      event.stopPropagation();
      stateRef.current = { ...stateRef.current, pending: resolved.pending };
      setPending(resolved.pending);
      if (resolved.command) run(resolved.command);
    };
    // 図の中から来た合図は、いた場所 (作業エリア) を載せてくる
    const onLeader = (event: Event) => {
      if (overlayOpen()) return;
      const from = (event as CustomEvent<{ region?: KeyNavRegion } | null>)
        .detail?.region;
      if (stateRef.current.mode === "normal") exitToInsert();
      else enterNormal(from);
    };
    // パレットが閉じたら、フォーカスをノーマルモードの置き場へ戻す
    const onPaletteClosed = (event: Event) => {
      if (stateRef.current.mode !== "normal") return;
      const detail = (event as CustomEvent<PaletteClosedDetail | null>).detail;
      if (detail?.handoff) {
        // 残っている置き直しが、開いたダイアログからフォーカスを奪わないようにする
        cancelRefocus();
        return;
      }
      sinkRef.current?.focus({ preventScroll: true });
      if (detail?.command) {
        run(detail.command);
        return;
      }
      const wanted = detail?.region ?? stateRef.current.region;
      const next = availableRegions(document).includes(wanted)
        ? wanted
        : stateRef.current.region;
      stateRef.current = { ...stateRef.current, region: next };
      setRegion(next);
      focusRegion(next);
    };
    // 入力欄をクリックしたら入力モードに戻す
    const onFocusIn = (event: FocusEvent) => {
      if (stateRef.current.mode === "normal" && isTextEntry(event.target)) {
        stateRef.current = { ...stateRef.current, mode: "insert" };
        setMode("insert");
        setHelpOpen(false);
      }
    };
    // iframe (端末・図) をクリックすると、親の window は blur だけを受け取る
    const onBlur = () => {
      window.setTimeout(() => {
        if (
          stateRef.current.mode === "normal" &&
          document.activeElement instanceof HTMLIFrameElement
        ) {
          stateRef.current = { ...stateRef.current, mode: "insert" };
          setMode("insert");
          setHelpOpen(false);
        }
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(KEYNAV_LEADER_EVENT, onLeader);
    window.addEventListener(PALETTE_CLOSED_EVENT, onPaletteClosed);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(KEYNAV_LEADER_EVENT, onLeader);
      window.removeEventListener(PALETTE_CLOSED_EVENT, onPaletteClosed);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onBlur);
      cancelRefocus();
      window.clearTimeout(deferredRef.current);
    };
  }, [cancelRefocus, enterNormal, exitToInsert, focusRegion, run]);

  // モードといる場所を <html> に出す (枠は index.css が描く)
  useEffect(() => {
    const root = document.documentElement;
    if (mode === "normal") {
      root.dataset.keynavMode = "normal";
      root.dataset.keynavActive = region;
    } else {
      delete root.dataset.keynavMode;
      delete root.dataset.keynavActive;
    }
    return () => {
      delete root.dataset.keynavMode;
      delete root.dataset.keynavActive;
    };
  }, [mode, region]);

  return (
    <>
      {/* ノーマルモードの間、置き先の無いフォーカスを受ける */}
      <div
        ref={sinkRef}
        tabIndex={-1}
        data-keynav-sink=""
        className="sr-only"
        aria-hidden="true"
      />
      {mode === "normal" && (
        <div
          data-testid="keynav-indicator"
          role="status"
          className="pointer-events-none fixed bottom-4 left-5 z-50 flex items-center gap-2 rounded-full bg-foreground px-3 py-1 font-mono text-[11px] font-semibold text-background shadow-panel"
        >
          <span>NORMAL</span>
          <span className="font-sans font-medium opacity-70">
            {REGION_LABEL[region]}
          </span>
          {pending && <span>{pending}</span>}
          <span className="font-sans font-medium opacity-50">? でキー一覧</span>
        </div>
      )}
      {mode === "normal" && helpOpen && (
        <div
          role="dialog"
          aria-label="キーの一覧"
          data-keynav-help=""
          className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-6"
        >
          <div className="panel max-h-full w-full max-w-[560px] overflow-y-auto p-5">
            <h2 className="mb-3 text-[15px] font-semibold">キーの一覧</h2>
            <div className="grid gap-4">
              {KEYNAV_HELP.map(group => (
                <section key={group.title}>
                  <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
                    {group.title}
                  </h3>
                  <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 rounded-xl bg-well px-3 py-2 text-[13px]">
                    {group.rows.map(([keys, what]) => (
                      <div key={keys} className="contents">
                        <dt className="font-mono font-semibold">{keys}</dt>
                        <dd className="m-0">{what}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Esc か ? で閉じる
            </p>
          </div>
        </div>
      )}
    </>
  );
}
