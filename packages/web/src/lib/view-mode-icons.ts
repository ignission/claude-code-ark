/**
 * view-mode-icons - 「会話 / 端末 / 図」の切り替えアイコンをPC・モバイルで一本化する
 *
 * PC (`SplitViewPane.tsx`) とモバイル (`MobileSessionViewModeToggle.tsx`) は
 * 同じ3操作を別々に描画しており、以前はアイコンがずれていた (#Task10レビュー)。
 * どちらもここを参照することで、以後の変更で再び乖離しないようにする。
 */

import type { LucideIcon } from "lucide-react";
import { MessagesSquare, SquareTerminal, Workflow } from "lucide-react";

export const VIEW_MODE_ICONS: Readonly<{
  chat: LucideIcon;
  terminal: LucideIcon;
  board: LucideIcon;
}> = {
  chat: MessagesSquare,
  terminal: SquareTerminal,
  board: Workflow,
};
