import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LISTEN_HOST,
  isLoopbackHost,
  listenOn,
  resolveListenHost,
} from "./listen-host.js";

describe("resolveListenHost", () => {
  it("指定が無ければ 127.0.0.1", () => {
    expect(resolveListenHost(undefined, undefined)).toBe("127.0.0.1");
    expect(DEFAULT_LISTEN_HOST).toBe("127.0.0.1");
  });

  it("ARK_HOST の値を使う", () => {
    expect(resolveListenHost(undefined, "0.0.0.0")).toBe("0.0.0.0");
  });

  it("明示の指定が ARK_HOST より優先される", () => {
    expect(resolveListenHost("::1", "0.0.0.0")).toBe("::1");
  });

  it("空や空白だけの値は未指定として扱う", () => {
    expect(resolveListenHost("", "  ")).toBe("127.0.0.1");
    expect(resolveListenHost("  ", " 0.0.0.0 ")).toBe("0.0.0.0");
  });
});

describe("isLoopbackHost", () => {
  it("ループバックのアドレスを見分ける", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.64.3")).toBe(false);
  });
});

describe("listenOn", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it("既定のアドレスで待ち受けると 127.0.0.1 だけに bind する", async () => {
    server = createServer();
    await listenOn(server, 0, resolveListenHost(undefined, undefined));
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");
  });

  it("使用中のポートでは reject する", async () => {
    server = createServer();
    await listenOn(server, 0, "127.0.0.1");
    const { port } = server.address() as AddressInfo;
    const second = createServer();
    await expect(listenOn(second, port, "127.0.0.1")).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});
