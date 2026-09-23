// @vitest-environment jsdom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Radix の Dialog は Portal と pointer イベントが絡むので素通しにする。
// ui/input.tsx・ui/textarea.tsx が同モジュールの useDialogComposition を
// 直接importするため、これも一緒にモックしないと Input 描画時に落ちる
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  useDialogComposition: () => ({
    isComposing: () => false,
    setComposing: () => {},
    justEndedComposing: () => false,
    markCompositionEnd: () => {},
  }),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-testid="alert">{children}</div> : null,
  AlertDialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" data-action="" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { ScreenManagerDialog } from "./ScreenManagerDialog";

const screen = {
  id: "s1",
  name: "ビルド VM",
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  createdAt: 0,
  updatedAt: 0,
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function setInput(container: HTMLElement, id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    b => b.textContent?.trim() === text
  );
  expect(button, text).toBeDefined();
  act(() => button?.click());
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  act(() => {
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function dialogProps(
  overrides: Partial<Parameters<typeof ScreenManagerDialog>[0]> = {}
) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    screens: [screen],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe("ScreenManagerDialog", () => {
  it("登録済みの画面を一覧に出す", () => {
    const container = mount(<ScreenManagerDialog {...dialogProps()} />);
    expect(container.textContent).toContain("ビルド VM");
    expect(container.textContent).toContain("user@build.example.internal:2222");
  });

  it("新規追加で必須項目を埋めると onCreate に既定値込みで渡す", () => {
    const props = dialogProps({ screens: [] });
    const container = mount(<ScreenManagerDialog {...props} />);
    clickButton(container, "新規追加");
    setInput(container, "screen-name", "新しい VM");
    setInput(container, "screen-ssh-host", "vm.example.internal");
    setInput(container, "screen-ssh-user", "user");
    setInput(container, "screen-vnc-user", "user");
    setInput(container, "screen-vnc-password", "pw");
    submitForm(container);

    expect(props.onCreate).toHaveBeenCalledWith({
      name: "新しい VM",
      sshHost: "vm.example.internal",
      sshPort: 22,
      sshUser: "user",
      vncHost: "127.0.0.1",
      vncPort: 5900,
      vncUser: "user",
      vncPassword: "pw",
    });
  });

  it("名前が空なら送らずにエラーを出す", () => {
    const props = dialogProps({ screens: [] });
    const container = mount(<ScreenManagerDialog {...props} />);
    clickButton(container, "新規追加");
    submitForm(container);
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("名前を入力してください");
  });

  it("編集ではパスワードを空のまま保存すると vncPassword を送らない", () => {
    const props = dialogProps();
    const container = mount(<ScreenManagerDialog {...props} />);
    const edit = container.querySelector<HTMLButtonElement>(
      'button[title="編集"]'
    );
    act(() => edit?.click());
    setInput(container, "screen-name", "改名");
    submitForm(container);

    expect(props.onUpdate).toHaveBeenCalledWith("s1", {
      name: "改名",
      sshHost: "build.example.internal",
      sshPort: 2222,
      sshUser: "user",
      vncHost: "127.0.0.1",
      vncPort: 5900,
      vncUser: "user",
    });
  });

  it("削除は確認してから onDelete を呼ぶ", () => {
    const props = dialogProps();
    const container = mount(<ScreenManagerDialog {...props} />);
    const del = container.querySelector<HTMLButtonElement>(
      'button[title="削除"]'
    );
    act(() => del?.click());
    expect(props.onDelete).not.toHaveBeenCalled();
    const confirm =
      document.body.querySelector<HTMLButtonElement>("[data-action]");
    act(() => confirm?.click());
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });
});
