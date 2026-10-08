import { File, Folder, FolderOpen } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import {
  fileIconName,
  folderIconName,
  getFileIconAssets,
  loadFileIconAssets,
  subscribeFileIconAssets,
} from "@/lib/file-icons";

interface Props {
  /** ファイル名またはディレクトリ名 (パスではなく末尾の名前) */
  name: string;
  kind: "file" | "dir";
  /** ディレクトリが開いているか */
  open?: boolean;
  className?: string;
}

const SIZE = "size-4 shrink-0";

/**
 * 種類ごとのアイコン。SVG が読み込まれるまで、または対応が無いときは
 * lucide の汎用アイコンを同じ大きさで出し、レイアウトを動かさない。
 */
export function FileIcon({ name, kind, open = false, className }: Props) {
  const assets = useSyncExternalStore(
    subscribeFileIconAssets,
    getFileIconAssets
  );
  useEffect(() => {
    void loadFileIconAssets();
  }, []);

  const iconName =
    kind === "dir" ? folderIconName(name, open) : fileIconName(name);
  const url = iconName ? assets?.iconUrl(iconName) : undefined;
  const cls = className ? `${SIZE} ${className}` : SIZE;

  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cls}
      />
    );
  }
  const fallback = `${cls} text-muted-foreground`;
  if (kind === "file") return <File className={fallback} />;
  return open ? (
    <FolderOpen className={fallback} />
  ) : (
    <Folder className={fallback} />
  );
}
