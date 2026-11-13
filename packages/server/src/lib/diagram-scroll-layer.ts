import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_SCROLL_LAYER_MARKER = "ark-diagram-scroll-layer";

/**
 * ボードのスクロール位置を親へ知らせ、親に言われた位置へ戻す層。
 *
 * Claude が同じ図を書き足すたびに、親は本文を取り直して iframe を作り直す。文書が
 * 新しくなるので、何もしないと見ていた場所が先頭へ戻る。親が位置を覚えておき、
 * 作り直した直後に `ark:diagram-restore-scroll` で戻させる (DiagramPane.tsx)。
 *
 * 扱うのは文書全体のスクロールだけ。図の中に独自のスクロール領域があっても、
 * その位置は戻さない (図の中身は解釈しない)。
 *
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const SCROLL_LAYER = `<script id="${DIAGRAM_SCROLL_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  var timer=null;
  function report(){
    timer=null;
    if(port)port.postMessage({type:"ark:diagram-scroll",x:window.scrollX,y:window.scrollY});
  }
  window.addEventListener("scroll",function(){
    if(!port||timer!==null)return;
    timer=setTimeout(report,100);
  },{passive:true});
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(message){
      var data=message.data;
      if(!data||data.type!=="ark:diagram-restore-scroll")return;
      if(typeof data.x!=="number"||typeof data.y!=="number")return;
      window.scrollTo(data.x,data.y);
    });
    port.start();
  });
})();
</script>`;

const scriptContentStart = SCROLL_LAYER.indexOf(">") + 1;
const scriptContentEnd = SCROLL_LAYER.lastIndexOf("</script>");
const minifyScrollLayerJavaScript = createCachedMinifier(
  SCROLL_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedScrollLayer: string | undefined;

function getMinifiedScrollLayer(): string {
  if (minifiedScrollLayer === undefined) {
    minifiedScrollLayer = `${SCROLL_LAYER.slice(0, scriptContentStart)}${minifyScrollLayerJavaScript()}${SCROLL_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedScrollLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_SCROLL_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramScrollLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedScrollLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
