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
  var pendingTimer=null;
  var operationError=null;
  var composerDraftBody="";
  // 送信はコメントの状態ではなく、その場の行為なので sidecar へ保存しない。
  // リロードで消えてよいページ内メモリとして threadId だけを覚える。
  var sentThreadIds=new Set();
  var requestSequence=0;
  var root=null;
  var anchors=[];
  var activeAddEntry=null;
  var addCloseTimer=null;
  var composerAnchorId=null;
  var composerAnchorQuote=null;
  var composerAnchorOccurrence=null;
  var selectedAnchorId=null;
  var selectedThreadId=null;
  var selectionAddButton=null;
  var selectionCandidate=null;
  var threadHighlightResolved=Object.create(null);
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
    root.querySelectorAll(".ark-comment-create,.ark-comment-resolve,.ark-comment-send,.ark-comment-input").forEach(function(control){
      control.disabled=Boolean(pendingRequestId)||control.getAttribute("data-sent")==="true";
    });
  }
  function rememberComposerInput(body){
    composerDraftBody=body;
  }
  function clearComposerInputs(){
    composerDraftBody="";
  }
  function send(type,payload){
    if(pendingRequestId)return;
    if(!port){
      if(type!=="ark:diagram-comments-load"){
        operationError={
          type:type,
          anchorId:payload&&payload.anchorId,
          threadId:payload&&payload.threadId,
          message:"コメント機能に接続できていません"
        };
        render();
      }
      return;
    }
    pendingRequestId=requestId();
    pendingAction={type:type,anchorId:payload&&payload.anchorId,threadId:payload&&payload.threadId};
    operationError=null;
    var message={type:type,requestId:pendingRequestId};
    Object.keys(payload||{}).forEach(function(key){message[key]=payload[key];});
    updatePendingControls();
    pendingTimer=window.setTimeout(function(){
      var timedOutAction=pendingAction;
      pendingRequestId=null;
      pendingAction=null;
      pendingTimer=null;
      updatePendingControls();
      if(timedOutAction&&timedOutAction.type!=="ark:diagram-comments-load"){
        operationError={
          type:timedOutAction.type,
          anchorId:timedOutAction.anchorId,
          threadId:timedOutAction.threadId,
          message:"応答がありません。もう一度お試しください"
        };
      }
      render();
    },15000);
    port.postMessage(message);
  }
  function setActiveAnchor(anchorId,threadId){
    anchors.forEach(function(entry){
      if(entry.anchorId===anchorId)entry.anchor.classList.add("ark-comment-anchor-active");
      else entry.anchor.classList.remove("ark-comment-anchor-active");
    });
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      var active=threadId?card.getAttribute("data-thread-id")===threadId:card.getAttribute("data-anchor-id")===anchorId;
      card.setAttribute("data-active",active?"true":"false");
    });
    document.querySelectorAll(".ark-comment-highlight").forEach(function(highlight){
      highlight.setAttribute("data-active",highlight.getAttribute("data-thread-id")===threadId?"true":"false");
    });
  }
  function cardInteraction(card,anchorId,threadId){
    card.addEventListener("mouseenter",function(){setActiveAnchor(anchorId,threadId);});
    card.addEventListener("mouseleave",function(){setActiveAnchor(selectedAnchorId,selectedThreadId);});
    card.addEventListener("click",function(){
      selectedAnchorId=anchorId;
      selectedThreadId=threadId||null;
      setActiveAnchor(anchorId,selectedThreadId);
    });
  }
  function addError(container,message){
    var error=element("p",message||"コメント処理に失敗しました","ark-comment-error");
    error.setAttribute("role","alert");
    container.appendChild(error);
  }
  function hideSelectionAdd(){
    selectionCandidate=null;
    if(selectionAddButton)selectionAddButton.setAttribute("data-visible","false");
  }
  function openComposer(anchorId,anchorQuote,anchorOccurrence){
    clearComposerInputs();
    composerAnchorId=anchorId;
    composerAnchorQuote=anchorQuote||null;
    composerAnchorOccurrence=anchorQuote?(anchorOccurrence||0):null;
    selectedAnchorId=anchorId;
    selectedThreadId=null;
    operationError=null;
    hideSelectionAdd();
    render();
    var input=root.querySelector(".ark-comment-composer .ark-comment-input");
    if(input)input.focus();
  }
  function renderThread(thread){
    var entry=anchorEntry(thread.anchorId);
    var unresolved=!entry||Boolean(thread.anchorQuote&&!threadHighlightResolved[thread.id]);
    var card=element("section",undefined,"ark-comment-card");
    card.setAttribute("data-anchor-id",thread.anchorId);
    card.setAttribute("data-thread-id",thread.id);
    card.setAttribute("data-status",thread.status);
    card.setAttribute("data-unresolved",unresolved?"true":"false");
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
    if(unresolved){
      content.appendChild(element("span","アンカー未解決","ark-comment-unresolved-anchor"));
      content.appendChild(element("p",thread.anchorQuote||thread.anchorText,"ark-comment-unresolved-quote"));
    }
    content.appendChild(element("span",thread.status==="open"?"未解決":"解決済み","ark-comment-state"));
    thread.messages.forEach(function(message){
      var item=element("article",undefined,"ark-comment-message");
      item.appendChild(element("time",message.at,"ark-comment-time"));
      item.appendChild(element("p",message.body,"ark-comment-body"));
      content.appendChild(item);
    });
    if(thread.status==="open"){
      var sendButton=element("button","→ Claude","ark-comment-send");
      sendButton.setAttribute("type","button");
      if(sentThreadIds.has(thread.id)){
        sendButton.textContent="送信済み";
        sendButton.setAttribute("data-sent","true");
        sendButton.disabled=true;
      }else{
        sendButton.addEventListener("click",function(event){
          event.stopPropagation();
          send("ark:diagram-comment-send",{threadId:thread.id});
        });
      }
      content.appendChild(sendButton);
      var resolveButton=element("button","解決する","ark-comment-resolve");
      resolveButton.setAttribute("type","button");
      resolveButton.addEventListener("click",function(event){
        event.stopPropagation();
        send("ark:diagram-comment-resolve",{threadId:thread.id});
      });
      content.appendChild(resolveButton);
    }
    if(operationError&&(operationError.type==="ark:diagram-comment-resolve"||operationError.type==="ark:diagram-comment-send")&&operationError.threadId===thread.id){
      addError(content,operationError.message);
    }
    card.appendChild(content);
    cardInteraction(card,thread.anchorId,thread.id);
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
      clearComposerInputs();
      composerAnchorId=null;
      composerAnchorQuote=null;
      composerAnchorOccurrence=null;
      operationError=null;
      render();
    });
    header.appendChild(closeButton);
    composer.appendChild(header);
    if(composerAnchorQuote){
      composer.appendChild(element("blockquote",composerAnchorQuote,"ark-comment-composer-quote"));
    }
    var bodyInput=element("textarea",undefined,"ark-comment-input");
    bodyInput.setAttribute("maxlength","4000");
    bodyInput.setAttribute("placeholder","コメント");
    bodyInput.value=composerDraftBody;
    composer.appendChild(bodyInput);
    bodyInput.addEventListener("input",function(){rememberComposerInput(bodyInput.value);});
    var createButton=element("button","コメントする","ark-comment-create");
    createButton.setAttribute("type","button");
    createButton.addEventListener("click",function(){
      rememberComposerInput(bodyInput.value);
      if(!bodyInput.value.trim()){
        operationError={type:"ark:diagram-comment-create",anchorId:anchorId,message:"コメント本文を入力してください"};
        render();
        return;
      }
      var payload=composerAnchorQuote?{
        anchorId:anchorId,
        anchorQuote:composerAnchorQuote,
        anchorOccurrence:composerAnchorOccurrence,
        body:bodyInput.value
      }:{
        anchorId:anchorId,
        body:bodyInput.value
      };
      send("ark:diagram-comment-create",payload);
    });
    composer.appendChild(createButton);
    if(operationError&&operationError.type==="ark:diagram-comment-create"&&operationError.anchorId===anchorId){
      addError(composer,operationError.message);
    }
    cardInteraction(composer,anchorId,null);
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
  function clearHighlights(){
    document.querySelectorAll('.ark-comment-highlight[data-ark-comment-owned="true"]').forEach(function(highlight){
      var parent=highlight.parentNode;
      highlight.replaceWith(document.createTextNode(highlight.textContent||""));
      if(parent&&parent.normalize)parent.normalize();
    });
    threadHighlightResolved=Object.create(null);
  }
  function collectTextNodes(anchor){
    var nodes=[];
    var text="";
    var walker=document.createTreeWalker(anchor,NodeFilter.SHOW_TEXT,{
      acceptNode:function(node){
        var parent=node.parentElement;
        if(!parent)return NodeFilter.FILTER_REJECT;
        if(parent.closest(".ark-comment-layer,script,style,noscript"))return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node=walker.nextNode();
    while(node){
      var value=node.nodeValue||"";
      nodes.push({node:node,start:text.length,end:text.length+value.length});
      text+=value;
      node=walker.nextNode();
    }
    return {nodes:nodes,text:text};
  }
  function quoteStarts(text,quote){
    var starts=[];
    var from=0;
    while(from<=text.length-quote.length){
      var found=text.indexOf(quote,from);
      if(found<0)break;
      starts.push(found);
      from=found+1;
    }
    return starts;
  }
  function quoteStart(text,quote,occurrence){
    var starts=quoteStarts(text,quote);
    var requested=occurrence===undefined?0:occurrence;
    if(requested<starts.length)return starts[requested];
    return starts.length===1?starts[0]:null;
  }
  function activateThread(thread){
    selectedAnchorId=thread.anchorId;
    selectedThreadId=thread.id;
    root.querySelectorAll(".ark-comment-card").forEach(function(card){
      if(card.getAttribute("data-thread-id")===thread.id)card.setAttribute("data-collapsed","false");
    });
    setActiveAnchor(thread.anchorId,thread.id);
    positionCards();
  }
  function wrapThreadQuote(thread,entry){
    var snapshot=collectTextNodes(entry.anchor);
    var start=quoteStart(snapshot.text,thread.anchorQuote,thread.anchorOccurrence);
    if(start===null)return false;
    var finish=start+thread.anchorQuote.length;
    for(var index=snapshot.nodes.length-1;index>=0;index-=1){
      var part=snapshot.nodes[index];
      var overlapStart=Math.max(start,part.start);
      var overlapEnd=Math.min(finish,part.end);
      if(overlapStart>=overlapEnd)continue;
      var value=part.node.nodeValue||"";
      var localStart=overlapStart-part.start;
      var localEnd=overlapEnd-part.start;
      var highlight=element("span",undefined,"ark-comment-highlight");
      highlight.setAttribute("data-thread-id",thread.id);
      highlight.setAttribute("data-ark-comment-owned","true");
      highlight.setAttribute("data-active","false");
      highlight.appendChild(document.createTextNode(value.slice(localStart,localEnd)));
      highlight.addEventListener("mouseenter",function(){setActiveAnchor(thread.anchorId,thread.id);});
      highlight.addEventListener("mouseleave",function(){setActiveAnchor(selectedAnchorId,selectedThreadId);});
      highlight.addEventListener("click",function(event){event.stopPropagation();activateThread(thread);});
      var replacements=[];
      if(localStart>0)replacements.push(document.createTextNode(value.slice(0,localStart)));
      replacements.push(highlight);
      if(localEnd<value.length)replacements.push(document.createTextNode(value.slice(localEnd)));
      part.node.replaceWith.apply(part.node,replacements);
    }
    return true;
  }
  function renderHighlights(){
    clearHighlights();
    comments.threads.forEach(function(thread){
      if(!thread.anchorQuote)return;
      var entry=anchorEntry(thread.anchorId);
      threadHighlightResolved[thread.id]=Boolean(entry&&wrapThreadQuote(thread,entry));
    });
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
    var unanchored=[];
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      var entry=anchorEntry(card.getAttribute("data-anchor-id"));
      if(!entry){unanchored.push(card);return;}
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
    unanchored.forEach(function(card){
      card.style.display="block";
      var cardTop=Math.max(8,previousBottom+CARD_GAP);
      card.style.top=cardTop+"px";
      previousBottom=cardTop+card.offsetHeight;
    });
    positionAddButtons();
  }
  function refreshLayout(){
    updateLayout();
    positionCards();
    updateSelectionAdd();
  }
  function render(){
    renderHighlights();
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      root.removeChild(card);
    });
    comments.threads.forEach(renderThread);
    renderComposer();
    updatePendingControls();
    updateLayout();
    setActiveAnchor(selectedAnchorId,selectedThreadId);
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
  function commonSelectionAnchor(range){
    var common=range.commonAncestorContainer;
    var commonElement=common.nodeType===Node.ELEMENT_NODE?common:common.parentElement;
    if(!commonElement||commonElement.closest(".ark-comment-layer"))return null;
    return commonElement.closest("[data-ark-id]");
  }
  function boundaryTextOffset(range,snapshot,endBoundary){
    var container=endBoundary?range.endContainer:range.startContainer;
    var containerOffset=endBoundary?range.endOffset:range.startOffset;
    for(var index=0;index<snapshot.nodes.length;index+=1){
      var part=snapshot.nodes[index];
      if(part.node===container)return part.start+containerOffset;
    }
    var offset=0;
    for(var partIndex=0;partIndex<snapshot.nodes.length;partIndex+=1){
      var candidate=snapshot.nodes[partIndex];
      var relation;
      try{relation=range.comparePoint(candidate.node,0);}catch(_error){continue;}
      if(relation<0||(endBoundary&&relation===0))offset=candidate.end;
      else return endBoundary?offset:candidate.start;
    }
    return snapshot.text.length;
  }
  function selectionDetails(){
    var selection=window.getSelection();
    if(!selection||selection.rangeCount!==1||selection.isCollapsed)return null;
    var range=selection.getRangeAt(0);
    var anchor=commonSelectionAnchor(range);
    if(!anchor)return null;
    var anchorId=anchor.getAttribute("data-ark-id");
    var snapshot=collectTextNodes(anchor);
    var selectedStart=boundaryTextOffset(range,snapshot,false);
    var selectedEnd=boundaryTextOffset(range,snapshot,true);
    var quote=snapshot.text.slice(selectedStart,selectedEnd);
    if(!anchorId||quote.trim().length===0||quote.length>1000)return null;
    var starts=quoteStarts(snapshot.text,quote);
    var occurrence=starts.indexOf(selectedStart);
    if(occurrence<0)return null;
    var rect=range.getBoundingClientRect();
    if(rect.width===0&&rect.height===0)return null;
    return {anchorId:anchorId,anchorQuote:quote,anchorOccurrence:occurrence,rect:rect};
  }
  function updateSelectionAdd(){
    var details=selectionDetails();
    if(!details){hideSelectionAdd();return;}
    selectionCandidate=details;
    selectionAddButton.style.top=Math.max(8,details.rect.bottom+6)+"px";
    selectionAddButton.style.left=Math.max(8,Math.min(window.innerWidth-96,details.rect.left+details.rect.width/2-40))+"px";
    selectionAddButton.setAttribute("data-visible","true");
  }
  function buildSelectionAdd(){
    selectionAddButton=element("button","コメント","ark-comment-selection-add");
    selectionAddButton.setAttribute("type","button");
    selectionAddButton.setAttribute("data-visible","false");
    selectionAddButton.addEventListener("mousedown",function(event){event.preventDefault();});
    selectionAddButton.addEventListener("click",function(){
      if(!selectionCandidate)return;
      openComposer(selectionCandidate.anchorId,selectionCandidate.anchorQuote,selectionCandidate.anchorOccurrence);
    });
    root.appendChild(selectionAddButton);
    document.addEventListener("selectionchange",updateSelectionAdd);
    document.addEventListener("mouseup",updateSelectionAdd);
    document.addEventListener("keyup",updateSelectionAdd);
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
      addButton.addEventListener("click",function(){openComposer(anchorId,null,null);});
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
    style.textContent=".ark-comment-layer{position:fixed;z-index:2147483000;inset:0;pointer-events:none;color:#172033;font:13px/1.5 system-ui,sans-serif}.ark-comment-card{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-composer{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #93c5fd;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-card[data-active=true],.ark-comment-composer[data-active=true]{border-color:#3b82f6;box-shadow:0 3px 16px #2563eb33}.ark-comment-card[data-status=resolved]{background:#f8fafc;border-color:#e2e8f0;color:#64748b;opacity:.78}.ark-comment-card[data-unresolved=true]{border-style:dashed}.ark-comment-badge{display:none}.ark-comment-card-content{display:block}.ark-comment-state,.ark-comment-time{display:block;color:#64748b;font-size:11px}.ark-comment-unresolved-anchor{display:block;color:#b45309;font-weight:700}.ark-comment-unresolved-quote,.ark-comment-composer-quote{margin:7px 0;padding:7px;border-left:3px solid #f59e0b;background:#fffbeb;white-space:pre-wrap}.ark-comment-message{border-top:1px solid #e2e8f0;margin-top:8px;padding-top:8px}.ark-comment-body{white-space:pre-wrap}.ark-comment-input{display:block;width:100%;box-sizing:border-box;margin:7px 0;padding:7px;border:1px solid #94a3b8;border-radius:5px;font:inherit}.ark-comment-create,.ark-comment-resolve,.ark-comment-send{border:0;border-radius:5px;background:#2563eb;color:#fff;padding:7px 10px;cursor:pointer}.ark-comment-create:disabled,.ark-comment-resolve:disabled,.ark-comment-send:disabled,.ark-comment-input:disabled{opacity:.5;cursor:default}.ark-comment-error{color:#b91c1c;margin:8px 0 0}.ark-comment-composer-header{display:flex;align-items:center;justify-content:space-between}.ark-comment-close{border:0;background:transparent;color:#64748b;font-size:18px;cursor:pointer}.ark-comment-add{position:fixed;z-index:2147483001;width:28px;height:28px;padding:0;border:1px solid #93c5fd;border-radius:999px;background:#fff;color:#2563eb;box-shadow:0 2px 8px #0002;cursor:pointer;opacity:0;pointer-events:none}.ark-comment-add[data-visible=true],.ark-comment-add:focus{opacity:1;pointer-events:auto}.ark-comment-selection-add{position:fixed;z-index:2147483002;border:0;border-radius:14px;background:#2563eb;color:#fff;padding:5px 10px;box-shadow:0 2px 8px #0003;cursor:pointer;opacity:0;pointer-events:none}.ark-comment-selection-add[data-visible=true]{opacity:1;pointer-events:auto}.ark-comment-highlight{background:#fde68a;border-radius:2px;cursor:pointer}.ark-comment-highlight[data-active=true]{background:#fbbf24;box-shadow:0 0 0 2px #f59e0b55}.ark-comment-anchor-active{background-color:rgba(219,234,254,.45);outline:1px solid rgba(37,99,235,.28);outline-offset:2px}.ark-comment-layer[data-narrow=true] .ark-comment-card{right:8px;width:auto;min-width:34px;padding:0;border:0;background:transparent;box-shadow:none;opacity:1}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-card-content{display:none}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-badge{display:block;width:34px;height:28px;border:0;border-radius:14px;background:#2563eb;color:#fff;box-shadow:0 2px 8px #0003;cursor:pointer}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-status=resolved][data-collapsed=true] .ark-comment-badge{background:#94a3b8}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false]{width:300px;padding:11px;border:1px solid #cbd5e1;background:#fff;box-shadow:0 3px 14px #0003}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false] .ark-comment-badge{display:none}";
    document.head.appendChild(style);
    root=element("div",undefined,"ark-comment-layer");
    root.setAttribute("data-narrow","false");
    document.body.appendChild(root);
    originalBodyPaddingRight=document.body.style.paddingRight;
    originalComputedPaddingRight=parseFloat(window.getComputedStyle(document.body).paddingRight)||0;
    buildSelectionAdd();
    buildAnchors();
    render();
  }
  function onPortMessage(event){
    var data=event.data;
    if(!data||data.type!=="ark:diagram-comments-result"||data.requestId!==pendingRequestId)return;
    var completedAction=pendingAction;
    if(pendingTimer)window.clearTimeout(pendingTimer);
    pendingTimer=null;
    pendingRequestId=null;
    pendingAction=null;
    if(data.ok){
      comments=data.comments;
      operationError=null;
      if(completedAction&&completedAction.type==="ark:diagram-comment-create"){
        clearComposerInputs();
        composerAnchorId=null;
        composerAnchorQuote=null;
        composerAnchorOccurrence=null;
      }else if(completedAction&&completedAction.type==="ark:diagram-comment-send"){
        sentThreadIds.add(completedAction.threadId);
      }
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
