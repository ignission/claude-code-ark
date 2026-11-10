import type { Messages } from "../ja";
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

export const en: Messages = {
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
