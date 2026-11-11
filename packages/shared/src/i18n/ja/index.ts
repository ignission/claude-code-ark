import { board } from "./board";
import { chat } from "./chat";
import { common } from "./common";
import { dialogs } from "./dialogs";
import { files } from "./files";
import { git } from "./git";
import { mobile } from "./mobile";
import { screen } from "./screen";
import { session } from "./session";
import { todo } from "./todo";
import { voice } from "./voice";

/** 日本語の辞書。キーの正本で、英語の辞書はこの形を型で強制される */
export const ja = {
  common,
  session,
  chat,
  mobile,
  voice,
  git,
  files,
  board,
  todo,
  dialogs,
  screen,
};

export type Messages = typeof ja;
