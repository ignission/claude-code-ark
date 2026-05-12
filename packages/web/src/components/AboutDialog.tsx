/**
 * F4 Step 8: About Dialog
 *
 * `.app` (Electron packaged) 環境で同梱されている tmux / ttyd と依存ライブラリの
 * LICENSE 一覧を表示する。サーバー側の `/api/licenses` から読み出した JSON を
 * accordion で展開可能にする。
 *
 * パッケージされていない環境 (CLI / 開発) では「Bundled binaries are not packaged
 * in this build.」のような表示にとどめる。
 *
 * 起動経路:
 *   - Electron main の `Menu > About Ark` (menu.ts) からの IPC、または
 *   - Header の About ボタンから直接 onOpenChange で開く想定
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LicensePackage {
  name: string;
  version?: string;
  license?: string;
  text: string;
}

interface LicensesResponse {
  packages: LicensePackage[];
  available: boolean;
}

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const [data, setData] = useState<LicensesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch("/api/licenses")
      .then(async res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as LicensesResponse;
      })
      .then(res => {
        setData(res);
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>About Ark</DialogTitle>
          <DialogDescription>
            ローカルで稼働する複数 Claude Code セッションを管理する Web UI。
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="font-semibold text-sm">同梱コンポーネント</h3>
          {loading && (
            <p className="text-muted-foreground text-sm">Loading...</p>
          )}
          {error && (
            <p className="text-destructive text-sm">
              Failed to load licenses: {error}
            </p>
          )}
          {!loading && !error && data && !data.available && (
            <p className="text-muted-foreground text-sm">
              Bundled binaries are not packaged in this build.
            </p>
          )}
          {!loading && data?.available && data.packages.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No bundled components registered.
            </p>
          )}
          <ul className="space-y-1">
            {data?.packages.map(pkg => (
              <li
                className="rounded border border-border bg-muted/30 p-2"
                key={pkg.name}
              >
                <Button
                  className="w-full justify-start text-left"
                  onClick={() =>
                    setExpanded(expanded === pkg.name ? null : pkg.name)
                  }
                  size="sm"
                  variant="ghost"
                >
                  <span className="font-mono text-sm">
                    {pkg.name}
                    {pkg.version ? ` (v${pkg.version})` : ""}
                  </span>
                  {pkg.license && (
                    <span className="ml-2 text-muted-foreground text-xs">
                      [{pkg.license}]
                    </span>
                  )}
                </Button>
                {expanded === pkg.name && (
                  <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
                    {pkg.text || "(LICENSE file not available)"}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </section>
      </DialogContent>
    </Dialog>
  );
}
