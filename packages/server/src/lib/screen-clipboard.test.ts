import { describe, expect, it } from "vitest";
import {
  buildPbcopyArgs,
  SCREEN_PASTE_MAX_BYTES,
  setRemoteClipboard,
} from "./screen-clipboard.js";

const target = {
  sshHost: "192.168.64.1",
  sshPort: 2222,
  sshUser: "admin",
  vncHost: "127.0.0.1",
  vncPort: 5900,
};

describe("buildPbcopyArgs", () => {
  it("画面と同じ SSH の宛先で、UTF-8 を指定した pbcopy を叩く", () => {
    expect(buildPbcopyArgs(target)).toEqual([
      "-o",
      "BatchMode=yes",
      "-p",
      "2222",
      "admin@192.168.64.1",
      "LANG=en_US.UTF-8 pbcopy",
    ]);
  });
});

describe("setRemoteClipboard", () => {
  it("VNC の宛先が SSH ホスト自身でなければ、ssh を起動せず unsupported を返す", async () => {
    await expect(
      setRemoteClipboard({ ...target, vncHost: "10.0.0.5" }, "x")
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
  });

  it("上限を超える本文は送らない", async () => {
    await expect(
      setRemoteClipboard(target, "a".repeat(SCREEN_PASTE_MAX_BYTES + 1))
    ).resolves.toEqual({ ok: false, reason: "too_large" });
  });
});
