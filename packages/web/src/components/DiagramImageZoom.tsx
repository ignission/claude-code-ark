/**
 * DiagramImageZoom - ボードの中で押された画像を、画面のほぼ全体に重ねて見せる
 *
 * ボードの iframe はペインの大きさしかないので、拡大は親の画面でやる。画像は
 * 図の中の層 (diagram-image-layer.ts) が data URL で送ってくる。`<img>` で描くだけなので、
 * SVG に書かれたスクリプトは動かない。
 *
 * どこを押しても閉じる (Esc でも閉じる)。開いたら閉じるボタンへフォーカスを移し、
 * 閉じたら元の場所へ戻す。
 */

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { m } from "@/lib/i18n";

/** 図の中の層が port 経由で送ってくる、押された画像 */
export interface DiagramZoomedImage {
  src: string;
  alt: string;
}

/** 受け取る data URL の長さの上限 (層の側と同じ) */
const MAX_SRC_LENGTH = 20_000_000;

export function readDiagramImageMessage(
  data: unknown
): DiagramZoomedImage | null {
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "ark:diagram-image"
  ) {
    return null;
  }
  const { src, alt } = data as { src?: unknown; alt?: unknown };
  // 図の中身は信頼しない。画像の data URL だけを受け取る
  if (typeof src !== "string" || !src.startsWith("data:image/")) return null;
  if (src.length > MAX_SRC_LENGTH) return null;
  return { src, alt: typeof alt === "string" ? alt.slice(0, 200) : "" };
}

export function DiagramImageZoom({
  image,
  onClose,
}: {
  image: DiagramZoomedImage;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // 画像の縦横比。読めたら、比を保ったまま画面に収まる最大の大きさへ広げる
  // (小さい画像も大きく見せる。余白を白く塗らないよう、箱を画像の形に合わせる)
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでは Esc と閉じるボタンで閉じる
    <div
      role="dialog"
      aria-modal="true"
      aria-label={m.board.imageZoom.label}
      data-diagram-image-zoom=""
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-3"
      onClick={onClose}
    >
      <img
        src={image.src}
        alt={image.alt}
        className="max-h-full max-w-full rounded-sm bg-white object-contain"
        style={
          ratio === null
            ? undefined
            : {
                aspectRatio: String(ratio),
                width: `min(100%, calc((100dvh - 1.5rem) * ${ratio}))`,
              }
        }
        onLoad={event => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setRatio(naturalWidth / naturalHeight);
          }
        }}
      />
      <button
        ref={closeRef}
        type="button"
        aria-label={m.board.imageZoom.close}
        title={m.board.imageZoom.close}
        className="absolute right-3 top-3 inline-flex size-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        onClick={onClose}
      >
        <X className="size-5" aria-hidden="true" />
      </button>
    </div>,
    document.body
  );
}
