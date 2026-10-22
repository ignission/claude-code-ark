/**
 * リモート画面のクリップボードを、SSH 越しの `pbcopy` で書き換える。
 *
 * macOS の画面共有は、Apple 以外の VNC クライアントから届く ClientCutText を
 * 正しく扱わない。受け取ると、相手側の Cmd+V で何も貼られなくなる。そこで
 * 手元のクリップボードは RFB に載せず、画面と同じ SSH の宛先で `pbcopy` に渡す。
 * 本文は stdin で渡すので、コマンドラインには載らない。
 *
 * `pbcopy` を叩く SSH の宛先が画面の持ち主であるのは、VNC の宛先がその SSH ホスト
 * 自身 (ループバック) のときだけ。踏み台の先の画面では使わない。
 */

import { spawn } from "node:child_process";
import type { ScreenPasteResult } from "@ark/shared";
import type { ScreenSshTarget } from "./screen-bridge.js";

/** 1 回に送る本文の上限 (バイト)。手で貼る量を超えるものは受けない */
export const SCREEN_PASTE_MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const STDERR_CAP = 4096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** pbcopy は LANG を見て stdin を解釈する。UTF-8 を明示しないと日本語が化ける */
const REMOTE_COMMAND = "LANG=en_US.UTF-8 pbcopy";

export function buildPbcopyArgs(target: ScreenSshTarget): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-p",
    String(target.sshPort),
    `${target.sshUser}@${target.sshHost}`,
    REMOTE_COMMAND,
  ];
}

export function setRemoteClipboard(
  target: ScreenSshTarget,
  text: string
): Promise<ScreenPasteResult> {
  if (!LOOPBACK_HOSTS.has(target.vncHost)) {
    return Promise.resolve({ ok: false, reason: "unsupported" });
  }
  if (Buffer.byteLength(text) > SCREEN_PASTE_MAX_BYTES) {
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  return new Promise(resolve => {
    const child = spawn("ssh", buildPbcopyArgs(target), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (result: ScreenPasteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "timeout" });
    }, TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_CAP);
    });
    child.on("error", error => {
      finish({ ok: false, reason: error.message });
    });
    child.on("close", code => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, reason: stderr.trim() || `ssh exited (${code})` }
      );
    });
    // ssh が先に落ちると EPIPE が非同期の error で来る。close の側で失敗を返すので握る
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
