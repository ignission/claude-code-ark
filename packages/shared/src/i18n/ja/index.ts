import { common } from "./common";
import { session } from "./session";
import { chat } from "./chat";
import { mobile } from "./mobile";
import { voice } from "./voice";
import { git } from "./git";
import { files } from "./files";
import { board } from "./board";
import { todo } from "./todo";
import { dialogs } from "./dialogs";
import { screen } from "./screen";

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
