// FrontLine モバイルコントロール

function emitAction(action: string, value?: number) {
  window.dispatchEvent(
    new CustomEvent("frontline:mobile", {
      detail: { action, value },
    })
  );
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
          onTouchStart={e => {
            e.preventDefault();
            emitAction("fire");
          }}
          onTouchEnd={e => {
            e.preventDefault();
            emitAction("fireEnd");
          }}
          onTouchCancel={e => {
            e.preventDefault();
            emitAction("fireEnd");
          }}
        >
          射撃
        </button>
        <div className="flex flex-row gap-2">
          <button
            type="button"
            className={`${largeBtn} flex-1`}
            onTouchStart={e => {
              e.preventDefault();
              emitAction("moveLeft");
            }}
            onTouchEnd={e => {
              e.preventDefault();
              emitAction("moveLeftEnd");
            }}
            onTouchCancel={e => {
              e.preventDefault();
              emitAction("moveLeftEnd");
            }}
          >
            ◀
          </button>
          <button
            type="button"
            className={`${largeBtn} flex-1`}
            onTouchStart={e => {
              e.preventDefault();
              emitAction("moveRight");
            }}
            onTouchEnd={e => {
              e.preventDefault();
              emitAction("moveRightEnd");
            }}
            onTouchCancel={e => {
              e.preventDefault();
              emitAction("moveRightEnd");
            }}
          >
            ▶
          </button>
        </div>
        <button
          type="button"
          className={`${largeBtn} w-full`}
          onTouchStart={e => {
            e.preventDefault();
            emitAction("defend");
          }}
          onTouchEnd={e => {
            e.preventDefault();
            emitAction("defendEnd");
          }}
          onTouchCancel={e => {
            e.preventDefault();
            emitAction("defendEnd");
          }}
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
              onTouchStart={e => {
                e.preventDefault();
                emitAction("weapon", i);
              }}
            >
              {i}
            </button>
          ))}
          <button
            type="button"
            className={smallBtn}
            onTouchStart={e => {
              e.preventDefault();
              emitAction("reload");
            }}
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
            onTouchStart={e => {
              e.preventDefault();
              emitAction("aimUp");
            }}
            onTouchEnd={e => {
              e.preventDefault();
              emitAction("aimUpEnd");
            }}
            onTouchCancel={e => {
              e.preventDefault();
              emitAction("aimUpEnd");
            }}
          >
            ▲
          </button>
          <button
            type="button"
            className="flex-1 bg-white/10 rounded-b-lg text-white text-xl font-mono select-none touch-manipulation active:bg-white/25 transition-colors flex items-center justify-center border-t border-white/5"
            onTouchStart={e => {
              e.preventDefault();
              emitAction("aimDown");
            }}
            onTouchEnd={e => {
              e.preventDefault();
              emitAction("aimDownEnd");
            }}
            onTouchCancel={e => {
              e.preventDefault();
              emitAction("aimDownEnd");
            }}
          >
            ▼
          </button>
        </div>
        {/* 射撃: 縦いっぱい */}
        <button
          type="button"
          className="flex-1 bg-red-900/40 rounded-lg text-white text-lg font-bold font-mono select-none touch-manipulation active:bg-red-700/50 transition-colors border border-red-800/30 flex items-center justify-center min-w-[64px]"
          onTouchStart={e => {
            e.preventDefault();
            emitAction("fire");
          }}
          onTouchEnd={e => {
            e.preventDefault();
            emitAction("fireEnd");
          }}
          onTouchCancel={e => {
            e.preventDefault();
            emitAction("fireEnd");
          }}
        >
          射撃
        </button>
      </div>
    </div>
  );
}
