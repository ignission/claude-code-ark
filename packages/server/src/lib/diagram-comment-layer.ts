export const DIAGRAM_COMMENT_LAYER_MARKER = "ark-diagram-comment-layer";

const COMMENT_LAYER = `<script id="${DIAGRAM_COMMENT_LAYER_MARKER}">
(function(){
  "use strict";
  var CARD_WIDTH=300;
  var CARD_GAP=10;
  var RAIL_GAP=12;
  var MIN_CONTENT_WIDTH=480;
  var AFFORDANCE_CLOSE_DELAY=120;
  var port=null;
  var comments={version:1,target:"",threads:[]};
  var pendingRequestId=null;
  var pendingAction=null;
  var operationError=null;
  var requestSequence=0;
  var root=null;
  var anchors=[];
  var activeAddEntry=null;
  var addCloseTimer=null;
  var composerAnchorId=null;
  var selectedAnchorId=null;
  var narrow=false;
  var originalBodyPaddingRight="";
  var originalComputedPaddingRight=0;

  function element(tag,text,className){
    var value=document.createElement(tag);
    if(text!==undefined)value.textContent=text;
    if(className)value.setAttribute("class",className);
    return value;
  }
  function clear(value){while(value.firstChild)value.removeChild(value.firstChild);}
  function requestId(){requestSequence+=1;return "comment-"+Date.now()+"-"+requestSequence;}
  function anchorEntry(anchorId){
    return anchors.filter(function(entry){return entry.anchorId===anchorId;})[0]||null;
  }
  function updatePendingControls(){
    root.querySelectorAll(".ark-comment-create,.ark-comment-resolve,.ark-comment-input").forEach(function(control){
      control.disabled=Boolean(pendingRequestId);
    });
  }
  function send(type,payload){
    if(!port||pendingRequestId)return;
    pendingRequestId=requestId();
    pendingAction={type:type,anchorId:payload&&payload.anchorId,threadId:payload&&payload.threadId};
    operationError=null;
    var message={type:type,requestId:pendingRequestId};
    Object.keys(payload||{}).forEach(function(key){message[key]=payload[key];});
    updatePendingControls();
    port.postMessage(message);
  }
  function setActiveAnchor(anchorId){
    anchors.forEach(function(entry){
      if(entry.anchorId===anchorId)entry.anchor.classList.add("ark-comment-anchor-active");
      else entry.anchor.classList.remove("ark-comment-anchor-active");
    });
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      card.setAttribute("data-active",card.getAttribute("data-anchor-id")===anchorId?"true":"false");
    });
  }
  function cardInteraction(card,anchorId){
    card.addEventListener("mouseenter",function(){setActiveAnchor(anchorId);});
    card.addEventListener("mouseleave",function(){setActiveAnchor(selectedAnchorId);});
    card.addEventListener("click",function(){
      selectedAnchorId=anchorId;
      setActiveAnchor(anchorId);
    });
  }
  function addError(container,message){
    var error=element("p",message||"コメント処理に失敗しました","ark-comment-error");
    error.setAttribute("role","alert");
    container.appendChild(error);
  }
  function openComposer(anchorId){
    composerAnchorId=anchorId;
    selectedAnchorId=anchorId;
    operationError=null;
    render();
    var input=root.querySelector(".ark-comment-composer .ark-comment-input");
    if(input)input.focus();
  }
  function renderThread(thread){
    var entry=anchorEntry(thread.anchorId);
    if(!entry)return;
    var card=element("section",undefined,"ark-comment-card");
    card.setAttribute("data-anchor-id",thread.anchorId);
    card.setAttribute("data-thread-id",thread.id);
    card.setAttribute("data-status",thread.status);
    card.setAttribute("data-collapsed","true");
    var openCount=comments.threads.filter(function(candidate){
      return candidate.anchorId===thread.anchorId&&candidate.status==="open";
    }).length;
    var badge=element("button",String(openCount),"ark-comment-badge");
    badge.setAttribute("type","button");
    badge.setAttribute("aria-label",openCount>0?"未解決コメント "+openCount+" 件":"解決済みコメント");
    badge.addEventListener("click",function(event){
      event.stopPropagation();
      card.setAttribute("data-collapsed",card.getAttribute("data-collapsed")==="true"?"false":"true");
      positionCards();
    });
    card.appendChild(badge);
    var content=element("div",undefined,"ark-comment-card-content");
    content.appendChild(element("strong",thread.anchorText,"ark-comment-anchor-text"));
    content.appendChild(element("span",thread.status==="open"?"未解決":"解決済み","ark-comment-state"));
    thread.messages.forEach(function(message){
      var item=element("article",undefined,"ark-comment-message");
      item.appendChild(element("b",message.author,"ark-comment-author"));
      item.appendChild(element("time",message.at,"ark-comment-time"));
      item.appendChild(element("p",message.body,"ark-comment-body"));
      content.appendChild(item);
    });
    if(thread.status==="open"){
      var resolveButton=element("button","解決する","ark-comment-resolve");
      resolveButton.setAttribute("type","button");
      resolveButton.addEventListener("click",function(event){
        event.stopPropagation();
        send("ark:diagram-comment-resolve",{threadId:thread.id});
      });
      content.appendChild(resolveButton);
    }
    if(operationError&&operationError.type==="ark:diagram-comment-resolve"&&operationError.threadId===thread.id){
      addError(content,operationError.message);
    }
    card.appendChild(content);
    cardInteraction(card,thread.anchorId);
    root.appendChild(card);
  }
  function renderComposer(){
    if(!composerAnchorId||!anchorEntry(composerAnchorId))return;
    var anchorId=composerAnchorId;
    var composer=element("section",undefined,"ark-comment-composer");
    composer.setAttribute("data-anchor-id",anchorId);
    var header=element("div",undefined,"ark-comment-composer-header");
    header.appendChild(element("strong","新しいコメント"));
    var closeButton=element("button","×","ark-comment-close");
    closeButton.setAttribute("type","button");
    closeButton.setAttribute("aria-label","コメント入力を閉じる");
    closeButton.addEventListener("click",function(){
      if(pendingRequestId)return;
      composerAnchorId=null;
      operationError=null;
      render();
    });
    header.appendChild(closeButton);
    composer.appendChild(header);
    var authorInput=element("input",undefined,"ark-comment-input");
    authorInput.setAttribute("type","text");
    authorInput.setAttribute("maxlength","80");
    authorInput.setAttribute("placeholder","名前");
    composer.appendChild(authorInput);
    var bodyInput=element("textarea",undefined,"ark-comment-input");
    bodyInput.setAttribute("maxlength","4000");
    bodyInput.setAttribute("placeholder","コメント");
    composer.appendChild(bodyInput);
    var createButton=element("button","コメントする","ark-comment-create");
    createButton.setAttribute("type","button");
    createButton.addEventListener("click",function(){
      send("ark:diagram-comment-create",{
        anchorId:anchorId,
        author:authorInput.value,
        body:bodyInput.value
      });
    });
    composer.appendChild(createButton);
    if(operationError&&operationError.type==="ark:diagram-comment-create"&&operationError.anchorId===anchorId){
      addError(composer,operationError.message);
    }
    cardInteraction(composer,anchorId);
    root.appendChild(composer);
  }
  function updateLayout(){
    var hasCards=root.querySelectorAll(".ark-comment-card,.ark-comment-composer").length>0;
    narrow=hasCards&&document.documentElement.clientWidth-CARD_WIDTH-RAIL_GAP*2<MIN_CONTENT_WIDTH;
    root.setAttribute("data-narrow",narrow?"true":"false");
    if(hasCards&&!narrow){
      document.body.style.paddingRight=(originalComputedPaddingRight+CARD_WIDTH+RAIL_GAP*2)+"px";
    }else{
      document.body.style.paddingRight=originalBodyPaddingRight;
    }
  }
  function positionAddButtons(){
    anchors.forEach(function(entry){
      var rect=entry.anchor.getBoundingClientRect();
      var buttonLeft=rect.right-2;
      if(buttonLeft+28>window.innerWidth)buttonLeft=Math.max(0,rect.left-26);
      entry.addButton.style.top=Math.max(8,rect.top+Math.min(rect.height/2,20)-14)+"px";
      entry.addButton.style.left=buttonLeft+"px";
      entry.addButton.style.display=rect.bottom<0||rect.top>window.innerHeight?"none":"block";
    });
  }
  function positionCards(){
    var entries=[];
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      var entry=anchorEntry(card.getAttribute("data-anchor-id"));
      if(!entry)return;
      entries.push({card:card,anchor:entry.anchor,rect:entry.anchor.getBoundingClientRect()});
    });
    entries.sort(function(left,right){return left.rect.top-right.rect.top;});
    var previousBottom=-CARD_GAP;
    entries.forEach(function(entry){
      var rect=entry.anchor.getBoundingClientRect();
      if(rect.bottom<0||rect.top>window.innerHeight){
        entry.card.style.display="none";
        return;
      }
      entry.card.style.display="block";
      var anchorTop=Math.max(8,rect.top);
      var cardTop=Math.max(anchorTop,previousBottom+CARD_GAP);
      entry.card.style.top=cardTop+"px";
      previousBottom=cardTop+entry.card.offsetHeight;
    });
    positionAddButtons();
  }
  function refreshLayout(){
    updateLayout();
    positionCards();
  }
  function render(){
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      root.removeChild(card);
    });
    comments.threads.forEach(renderThread);
    renderComposer();
    updatePendingControls();
    updateLayout();
    setActiveAnchor(selectedAnchorId);
    window.requestAnimationFrame(positionCards);
  }
  function showAdd(entry){
    clearAddClose();
    activeAddEntry=entry;
    anchors.forEach(function(candidate){
      candidate.addButton.setAttribute("data-visible","false");
    });
    entry.addButton.setAttribute("data-visible","true");
    positionAddButtons();
  }
  function hideAdd(){
    if(!activeAddEntry)return;
    activeAddEntry.addButton.setAttribute("data-visible","false");
    activeAddEntry=null;
    setActiveAnchor(selectedAnchorId);
  }
  function clearAddClose(){
    if(addCloseTimer===null)return;
    window.clearTimeout(addCloseTimer);
    addCloseTimer=null;
  }
  function scheduleAddClose(){
    clearAddClose();
    addCloseTimer=window.setTimeout(function () {
      addCloseTimer=null;
      if(!activeAddEntry)return;
      if(activeAddEntry.anchor.matches(":hover")||
        activeAddEntry.addButton.matches(":hover")||
        activeAddEntry.addButton.matches(":focus"))return;
      hideAdd();
    },AFFORDANCE_CLOSE_DELAY);
  }
  function buildAnchors(){
    document.querySelectorAll("[data-ark-id]").forEach(function(anchor){
      var anchorId=anchor.getAttribute("data-ark-id");
      if(!anchorId)return;
      var addButton=element("button","＋","ark-comment-add");
      addButton.setAttribute("type","button");
      addButton.setAttribute("aria-label",anchorId+" にコメントを追加");
      addButton.setAttribute("data-visible","false");
      var entry={anchor:anchor,anchorId:anchorId,addButton:addButton};
      addButton.addEventListener("focus",function(){
        showAdd(entry);
        setActiveAnchor(anchorId);
      });
      addButton.addEventListener("blur",scheduleAddClose);
      addButton.addEventListener("click",function(){openComposer(anchorId);});
      root.appendChild(addButton);
      anchors.push(entry);
    });
    document.addEventListener("mouseover",function(event){
      if(!event.target||!event.target.closest)return;
      var hoveredButton=event.target.closest(".ark-comment-add");
      if(hoveredButton){
        var buttonEntry=anchors.filter(function(entry){return entry.addButton===hoveredButton;})[0]||null;
        if(buttonEntry)showAdd(buttonEntry);
        return;
      }
      if(activeAddEntry&&activeAddEntry.addButton.matches(":focus"))return;
      var anchor=event.target.closest("[data-ark-id]");
      if(anchor){
        var entry=anchors.filter(function(candidate){return candidate.anchor===anchor;})[0]||null;
        if(entry){
          showAdd(entry);
          setActiveAnchor(entry.anchorId);
          return;
        }
      }
      scheduleAddClose();
    });
    document.addEventListener("mouseout",function(event){
      if(!event.relatedTarget)scheduleAddClose();
    });
  }
  function build(){
    var style=element("style");
    style.textContent=".ark-comment-layer{position:fixed;z-index:2147483000;inset:0;pointer-events:none;color:#172033;font:13px/1.5 system-ui,sans-serif}.ark-comment-card{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-composer{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #93c5fd;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-card[data-active=true],.ark-comment-composer[data-active=true]{border-color:#3b82f6;box-shadow:0 3px 16px #2563eb33}.ark-comment-card[data-status=resolved]{background:#f8fafc;border-color:#e2e8f0;color:#64748b;opacity:.78}.ark-comment-badge{display:none}.ark-comment-card-content{display:block}.ark-comment-state,.ark-comment-time{display:block;color:#64748b;font-size:11px}.ark-comment-message{border-top:1px solid #e2e8f0;margin-top:8px;padding-top:8px}.ark-comment-body{white-space:pre-wrap}.ark-comment-input{display:block;width:100%;box-sizing:border-box;margin:7px 0;padding:7px;border:1px solid #94a3b8;border-radius:5px;font:inherit}.ark-comment-create,.ark-comment-resolve{border:0;border-radius:5px;background:#2563eb;color:#fff;padding:7px 10px;cursor:pointer}.ark-comment-create:disabled,.ark-comment-resolve:disabled,.ark-comment-input:disabled{opacity:.5;cursor:default}.ark-comment-error{color:#b91c1c;margin:8px 0 0}.ark-comment-composer-header{display:flex;align-items:center;justify-content:space-between}.ark-comment-close{border:0;background:transparent;color:#64748b;font-size:18px;cursor:pointer}.ark-comment-add{position:fixed;z-index:2147483001;width:28px;height:28px;padding:0;border:1px solid #93c5fd;border-radius:999px;background:#fff;color:#2563eb;box-shadow:0 2px 8px #0002;cursor:pointer;opacity:0;pointer-events:none}.ark-comment-add[data-visible=true],.ark-comment-add:focus{opacity:1;pointer-events:auto}.ark-comment-anchor-active{background-color:rgba(219,234,254,.45);outline:1px solid rgba(37,99,235,.28);outline-offset:2px}.ark-comment-layer[data-narrow=true] .ark-comment-card{right:8px;width:auto;min-width:34px;padding:0;border:0;background:transparent;box-shadow:none;opacity:1}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-card-content{display:none}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-badge{display:block;width:34px;height:28px;border:0;border-radius:14px;background:#2563eb;color:#fff;box-shadow:0 2px 8px #0003;cursor:pointer}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-status=resolved][data-collapsed=true] .ark-comment-badge{background:#94a3b8}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false]{width:300px;padding:11px;border:1px solid #cbd5e1;background:#fff;box-shadow:0 3px 14px #0003}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false] .ark-comment-badge{display:none}";
    document.head.appendChild(style);
    root=element("div",undefined,"ark-comment-layer");
    root.setAttribute("data-narrow","false");
    document.body.appendChild(root);
    originalBodyPaddingRight=document.body.style.paddingRight;
    originalComputedPaddingRight=parseFloat(window.getComputedStyle(document.body).paddingRight)||0;
    buildAnchors();
    render();
  }
  function onPortMessage(event){
    var data=event.data;
    if(!data||data.type!=="ark:diagram-comments-result"||data.requestId!==pendingRequestId)return;
    var completedAction=pendingAction;
    pendingRequestId=null;
    pendingAction=null;
    if(data.ok){
      comments=data.comments;
      operationError=null;
      if(completedAction&&completedAction.type==="ark:diagram-comment-create")composerAnchorId=null;
    }else if(completedAction&&completedAction.type!=="ark:diagram-comments-load"){
      operationError={
        type:completedAction.type,
        anchorId:completedAction.anchorId,
        threadId:completedAction.threadId,
        message:data.error||"コメント処理に失敗しました"
      };
    }
    render();
  }
  window.addEventListener("wheel",function(event){
    if(!event.ctrlKey||!port)return;
    event.preventDefault();
    port.postMessage({type:"ark:diagram-pinch",deltaY:event.deltaY});
  },{passive:false});
  window.addEventListener("scroll",positionCards,{passive:true});
  window.addEventListener("resize",refreshLayout);
  var observer=new ResizeObserver(refreshLayout);
  observer.observe(document.documentElement);
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",onPortMessage);
    port.start();
    send("ark:diagram-comments-load",{});
  });
  build();
})();
</script>`;

/** 文書型ページだけへ独立したコメント層を注入する。 */
export function injectDiagramCommentLayer(html: string): string {
  if (html.includes(DIAGRAM_COMMENT_LAYER_MARKER)) return html;
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${COMMENT_LAYER}`;
  return `${html.slice(0, bodyClose)}${COMMENT_LAYER}${html.slice(bodyClose)}`;
}
