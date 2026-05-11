import { useEffect, useState } from "react";

interface VisualViewportState {
  height: number;
  offsetTop: number;
  isKeyboardVisible: boolean;
}

/**
 * visualViewport APIでviewport高さとキーボード表示状態を取得するカスタムフック。
 * Safari 13+でサポート。非対応ブラウザではwindow.innerHeightにフォールバック。
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>({
    height: typeof window !== "undefined" ? window.innerHeight : 0,
    offsetTop: 0,
    isKeyboardVisible: false,
  });

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const isKeyboardVisible = viewport.height < window.innerHeight * 0.75;
      setState({
        height: viewport.height,
        offsetTop: viewport.offsetTop,
        isKeyboardVisible,
      });
    };

    viewport.addEventListener("resize", handleResize);
    viewport.addEventListener("scroll", handleResize);
    handleResize();

    return () => {
      viewport.removeEventListener("resize", handleResize);
      viewport.removeEventListener("scroll", handleResize);
    };
  }, []);

  return state;
}
