// FrontLine モバイルコントロール

import type { KeyboardEvent, MouseEvent } from "react";

function emitAction(action: string, value?: number) {
  window.dispatchEvent(
    new CustomEvent("frontline:mobile", {
      detail: { action, value },
    })
  );
}

const btnClass =
  "bg-white/10 rounded px-3 py-2 text-white text-xs font-mono select-none touch-manipulation active:bg-white/25 transition-colors";

function handleKeyboardAction(
  event: KeyboardEvent<HTMLButtonElement>,
  action: string,
  value?: number
) {
  if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
  event.preventDefault();
  emitAction(action, value);
}

function handlePointerAction(
  event: MouseEvent<HTMLButtonElement>,
  action: string,
  value?: number
) {
  if (event.detail === 0) return;
  emitAction(action, value);
}

export function MobileControls() {
  return (
    <div className="flex flex-row gap-2 justify-center py-2">
      {[1, 2, 3, 4].map(i => (
        <button
          key={i}
          type="button"
          className={btnClass}
          onTouchStart={e => {
            e.preventDefault();
            emitAction("weapon", i);
          }}
          onClick={e => handlePointerAction(e, "weapon", i)}
          onKeyDown={e => handleKeyboardAction(e, "weapon", i)}
        >
          {i}
        </button>
      ))}
      <button
        type="button"
        className={btnClass}
        onTouchStart={e => {
          e.preventDefault();
          emitAction("reload");
        }}
        onClick={e => handlePointerAction(e, "reload")}
        onKeyDown={e => handleKeyboardAction(e, "reload")}
      >
        R
      </button>
      <button
        type="button"
        className={btnClass}
        onTouchStart={e => {
          e.preventDefault();
          emitAction("defend");
        }}
        onMouseDown={e => {
          e.preventDefault();
          emitAction("defend");
        }}
        onMouseUp={e => {
          e.preventDefault();
          emitAction("defendEnd");
        }}
        onMouseLeave={e => {
          if ((e.buttons & 1) === 1) {
            emitAction("defendEnd");
          }
        }}
        onTouchEnd={e => {
          e.preventDefault();
          emitAction("defendEnd");
        }}
        onTouchCancel={e => {
          e.preventDefault();
          emitAction("defendEnd");
        }}
        onClick={e => {
          if (e.detail === 0) return;
          e.preventDefault();
        }}
        onKeyDown={e => handleKeyboardAction(e, "defend")}
        onKeyUp={e => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          emitAction("defendEnd");
        }}
      >
        防御
      </button>
    </div>
  );
}
