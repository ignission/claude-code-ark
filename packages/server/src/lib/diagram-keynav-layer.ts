import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_KEYNAV_LAYER_MARKER = "ark-diagram-keynav-layer";

/**
 * ボードの中で押された前置キー (Ctrl+;) を親へ渡し、親からの指示で図を送る層。
 *
 * ボードの iframe は sandbox で出どころが別なので、図をクリックしたあとのキーは
 * 親の window に届かず、親は中の document にも触れない (端末の iframe は同じ出どころ
 * なので、親が直接リスナーを付けている)。ここで前置キーだけを横取りして親へ知らせ、
 * ほかのキーには触らない (doc の本文の編集やコメントの入力を変えない)。
 * ノーマルモードの間は親がフォーカスを持つので、j / k などは親が受けて、
 * 「どれだけ送るか」だけをここへ送ってくる。
 *
 * 前置キーの判定は web の `isLeaderKey` (lib/keynav.ts) と同じにする。
 * port と `data-ark-harness-ui="1"` の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const KEYNAV_LAYER = `<script id="${DIAGRAM_KEYNAV_LAYER_MARKER}" data-ark-harness-ui="1">
(function(){
  "use strict";
  var port=null;
  var LINE=80;
  function scroller(){
    return document.scrollingElement||document.documentElement;
  }
  function onScroll(data){
    var dir=data.dir===-1?-1:1;
    var el=scroller();
    if(data.unit==="edge"){
      window.scrollTo(window.scrollX,dir===-1?0:el.scrollHeight);
      return;
    }
    var amount=data.unit==="page"?Math.max(LINE,window.innerHeight/2):LINE;
    window.scrollBy(0,dir*amount);
  }
  document.addEventListener("keydown",function(event){
    if(!event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key!==";"&&event.code!=="Semicolon")return;
    if(event.isComposing||!port)return;
    event.preventDefault();
    event.stopPropagation();
    port.postMessage({type:"ark:diagram-keynav-leader"});
  },true);
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(message){
      var data=message.data;
      if(data&&data.type==="ark:diagram-keynav-scroll")onScroll(data);
    });
    port.start();
  });
})();
</script>`;

const scriptContentStart = KEYNAV_LAYER.indexOf(">") + 1;
const scriptContentEnd = KEYNAV_LAYER.lastIndexOf("</script>");
const minifyKeynavLayerJavaScript = createCachedMinifier(
  KEYNAV_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedKeynavLayer: string | undefined;

function getMinifiedKeynavLayer(): string {
  if (minifiedKeynavLayer === undefined) {
    minifiedKeynavLayer = `${KEYNAV_LAYER.slice(0, scriptContentStart)}${minifyKeynavLayerJavaScript()}${KEYNAV_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedKeynavLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_KEYNAV_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramKeynavLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedKeynavLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
