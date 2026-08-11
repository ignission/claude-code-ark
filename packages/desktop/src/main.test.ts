import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const electronApp = vi.hoisted(() => ({
  isPackaged: false,
  setName: vi.fn(),
  getPath: vi.fn((name: string) => `/tmp/ark-${name}`),
  whenReady: vi.fn(() => new Promise<void>(() => {})),
  on: vi.fn(),
  quit: vi.fn(),
}));

vi.mock("electron", () => ({
  app: electronApp,
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { resolvePathFn: vi.fn() } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./menu.js", () => ({ buildAppMenu: vi.fn() }));
vi.mock("./tray.js", () => ({
  createTray: vi.fn(),
  destroyTray: vi.fn(),
}));

import { resolveDiagramAuthoringGuidePath } from "./main.js";

const originalResourcesPath = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath"
);

afterAll(() => {
  if (originalResourcesPath) {
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  } else {
    Reflect.deleteProperty(process, "resourcesPath");
  }
});

describe("resolveDiagramAuthoringGuidePath", () => {
  it("packaged 時は process.resourcesPath 配下の同梱パスを返す", () => {
    electronApp.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/Applications/Ark.app/Contents/Resources",
    });

    expect(resolveDiagramAuthoringGuidePath()).toBe(
      path.join(
        "/Applications/Ark.app/Contents/Resources",
        "app",
        "diagram-authoring-guide.md"
      )
    );
  });

  it("unpackaged 時は undefined を返す", () => {
    electronApp.isPackaged = false;

    expect(resolveDiagramAuthoringGuidePath()).toBeUndefined();
  });
});
