// FrontLine モバイルコントロール

function emitAction(action: string, value?: number) {
  window.dispatchEvent(
    new CustomEvent("frontline:mobile", {
      detail: { action, value },
    })
  );
}

// タッチ+ポインター共通ハンドラ（キーボード・マウス操作にも対応）
function pressHandlers(startAction: string, endAction?: string) {
  const handlers: Record<string, (e: React.SyntheticEvent) => void> = {
    onTouchStart: e => {
      e.preventDefault();
      emitAction(startAction);
    },
    onPointerDown: e => {
      // タッチイベントが先に発火する場合の重複防止
      if ((e as React.PointerEvent).pointerType === "touch") return;
      emitAction(startAction);
    },
  };
  if (endAction) {
    handlers.onTouchEnd = e => {
      e.preventDefault();
      emitAction(endAction);
    };
    handlers.onTouchCancel = e => {
      e.preventDefault();
      emitAction(endAction);
    };
    handlers.onPointerUp = e => {
      if ((e as React.PointerEvent).pointerType === "touch") return;
      emitAction(endAction);
    };
    handlers.onPointerCancel = e => {
      if ((e as React.PointerEvent).pointerType === "touch") return;
      emitAction(endAction);
    };
  }
  return handlers;
}

const smallBtn =
  "bg-white/10 rounded px-3 py-2 text-white text-xs font-mono select-none touch-manipulation active:bg-white/25 transition-colors";

const largeBtn =
  "bg-white/15 rounded-lg px-5 py-4 text-white text-lg font-mono select-none touch-manipulation active:bg-white/30 transition-colors";

export function MobileControls() {
  return (
    <div className="flex flex-row items-stretch justify-between px-3 py-2 gap-2">
      {/* 左側: 射撃 + 移動 + 防御 */}
      <div className="flex flex-col gap-2 justify-end">
        <button
          type="button"
          className="w-full bg-red-900/40 rounded-lg py-4 text-white text-lg font-bold font-mono select-none touch-manipulation active:bg-red-700/50 transition-colors border border-red-800/30"
          {...pressHandlers("fire", "fireEnd")}
        >
          射撃
        </button>
        <div className="flex flex-row gap-2">
          <button
            type="button"
            className={`${largeBtn} flex-1`}
            {...pressHandlers("moveLeft", "moveLeftEnd")}
          >
            ◀
          </button>
          <button
            type="button"
            className={`${largeBtn} flex-1`}
            {...pressHandlers("moveRight", "moveRightEnd")}
          >
            ▶
          </button>
        </div>
        <button
          type="button"
          className={`${largeBtn} w-full`}
          {...pressHandlers("defend", "defendEnd")}
        >
          防御
        </button>
        {/* 武器選択 + リロード */}
        <div className="flex flex-row gap-1">
          {[1, 2, 3, 4, 5].map(i => (
            <button
              key={i}
              type="button"
              className={smallBtn}
              {...pressHandlers("weapon")}
              onTouchStart={e => {
                e.preventDefault();
                emitAction("weapon", i);
              }}
              onPointerDown={e => {
                if (e.pointerType === "touch") return;
                emitAction("weapon", i);
              }}
            >
              {i}
            </button>
          ))}
          <button
            type="button"
            className={smallBtn}
            {...pressHandlers("reload")}
          >
            R
          </button>
        </div>
      </div>

      {/* 右側: [▲▼] + [射撃] 横並び、縦いっぱい */}
      <div className="flex flex-row gap-1 self-stretch">
        {/* 照準上下: 隙間なし縦いっぱい */}
        <div className="flex flex-col w-[48px]">
          <button
            type="button"
            className="flex-1 bg-white/10 rounded-t-lg text-white text-xl font-mono select-none touch-manipulation active:bg-white/25 transition-colors flex items-center justify-center"
            {...pressHandlers("aimUp", "aimUpEnd")}
          >
            ▲
          </button>
          <button
            type="button"
            className="flex-1 bg-white/10 rounded-b-lg text-white text-xl font-mono select-none touch-manipulation active:bg-white/25 transition-colors flex items-center justify-center border-t border-white/5"
            {...pressHandlers("aimDown", "aimDownEnd")}
          >
            ▼
          </button>
        </div>
        {/* 射撃: 縦いっぱい */}
        <button
          type="button"
          className="flex-1 bg-red-900/40 rounded-lg text-white text-lg font-bold font-mono select-none touch-manipulation active:bg-red-700/50 transition-colors border border-red-800/30 flex items-center justify-center min-w-[64px]"
          {...pressHandlers("fire", "fireEnd")}
        >
          射撃
        </button>
      </div>
    </div>
  );
}
