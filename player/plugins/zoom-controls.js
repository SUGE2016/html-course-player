/* Local slide magnifier: anchored zoom and bounded viewport panning. */
(() => {
  class Viewport {
    constructor(width,height){this.width=Math.max(1,width);this.height=Math.max(1,height);this.scale=1;this.x=0;this.y=0;}
    limit(){this.x=Math.max(this.width*(1-this.scale),Math.min(0,this.x));this.y=Math.max(this.height*(1-this.scale),Math.min(0,this.y));return this;}
    focus(scale,x,y){this.scale=Math.max(1,Math.min(4,Math.round(scale*100)/100));this.x=this.width/2-x*this.scale;this.y=this.height/2-y*this.scale;return this.limit();}
    zoom(scale,x=this.width/2,y=this.height/2){
      if(!Number.isFinite(scale))return this;
      const next=Math.max(1,Math.min(4,Math.round(scale*100)/100)),worldX=(x-this.x)/this.scale,worldY=(y-this.y)/this.scale;
      this.x=x-worldX*next;this.y=y-worldY*next;this.scale=next;return this.limit();
    }
    pan(dx,dy){this.x+=dx;this.y+=dy;return this.limit();}
    center(){this.x=this.width*(1-this.scale)/2;this.y=this.height*(1-this.scale)/2;return this;}
  }
  if(typeof module==='object'&&module.exports)module.exports={Viewport};
  if(typeof document==='undefined'||typeof Reveal==='undefined')return;
  const root=document.querySelector('.reveal');if(!root)return;
  const style=document.createElement('style');
  style.textContent=`
    .lecture-zoom-active .reveal{cursor:grab;touch-action:none;user-select:none;overflow:visible}
    .lecture-zoom-active .reveal.viewport-dragging{cursor:grabbing}
    .lecture-zoom-active .reveal .controls,.lecture-zoom-active .reveal .progress,.lecture-zoom-active .reveal .slide-number{visibility:hidden}
    .viewport-controls{position:fixed;top:14px;right:14px;z-index:85;display:flex;align-items:center;gap:7px;flex-wrap:wrap;max-width:calc(100vw - 28px);box-sizing:border-box;padding:9px 11px;border:1px solid #b8ccd9;border-radius:9px;background:rgba(248,252,255,.97);box-shadow:0 7px 26px #10283f26;color:#193d56;font:600 14px/1.4 'Microsoft YaHei',sans-serif}
    .viewport-controls[hidden]{display:none!important}.viewport-controls button{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:34px;padding:0 9px;border:1px solid #b8cbd9;background:#fff;color:#193d56;border-radius:5px;font:inherit;cursor:pointer}
    .viewport-controls button:hover{background:#e8f8ff;border-color:#087eae}.viewport-controls .viewport-arrows{display:flex;gap:4px}.viewport-controls input{box-sizing:border-box;width:68px;height:34px;padding:4px 5px;border:1px solid #9fb9c9;border-radius:5px;font:600 15px Consolas,monospace;color:#087eae;background:#fff}
    .viewport-controls label{display:flex;align-items:center;gap:3px}.viewport-controls .viewport-hint{font-size:12px;color:#627d91;margin-right:5px}.viewport-controls .viewport-exit{background:#173c55;border-color:#173c55;color:#fff}
    @media(max-width:700px){.viewport-controls{gap:5px;padding:7px;top:8px;right:8px}.viewport-controls .viewport-hint{display:none}.viewport-controls button{padding:0 7px}}
    @media print{.viewport-controls{display:none!important}}
  `;
  document.head.append(style);
  const controls=document.createElement('div');controls.className='viewport-controls';controls.hidden=true;controls.setAttribute('role','group');controls.setAttribute('aria-label','放大视窗控制');
  controls.innerHTML='<span class="viewport-hint">拖动移动 · 滚轮微调</span><button type="button" data-zoom="less" aria-label="缩小5%">−</button><label><input type="number" min="100" max="400" step="1" value="200" aria-label="缩放比例百分比"><span>%</span></label><button type="button" data-zoom="more" aria-label="放大5%">＋</button><span class="viewport-arrows"><button type="button" data-pan="left" aria-label="视窗向左移动">←</button><button type="button" data-pan="up" aria-label="视窗向上移动">↑</button><button type="button" data-pan="down" aria-label="视窗向下移动">↓</button><button type="button" data-pan="right" aria-label="视窗向右移动">→</button></span><button type="button" data-zoom="center">居中</button><button type="button" data-zoom="exit" class="viewport-exit">退出放大 · Esc</button>';
  document.body.append(controls);
  const field=controls.querySelector('input');
  let active=false,viewport=null,base=null,prior=null,drag=null,suppressClickUntil=0,wheelTotal=0;
  const modifier=()=>Reveal.getConfig().zoomKey||(/Linux/.test(navigator.platform)?'ctrl':'alt');
  const matchesModifier=event=>Boolean(event[modifier()+'Key']);
  function apply(){
    if(!active)return;
    root.style.transformOrigin='0 0';root.style.transition='none';root.style.willChange='transform';
    root.style.transform=`translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
    root.dataset.viewportScale=String(Math.round(viewport.scale*100));field.value=root.dataset.viewportScale;
  }
  function reset(){
    if(!active)return;
    active=false;drag=null;wheelTotal=0;controls.hidden=true;
    root.style.transform=prior.transform;root.style.transformOrigin=prior.origin;root.style.transition=prior.transition;root.style.willChange=prior.willChange;
    root.classList.remove('viewport-dragging');document.documentElement.classList.remove('lecture-zoom-active');delete root.dataset.viewportScale;
  }
  function enter(x,y){
    if(Reveal.isOverview())return;
    base=root.getBoundingClientRect();prior={transform:root.style.transform,origin:root.style.transformOrigin,transition:root.style.transition,willChange:root.style.willChange};
    viewport=new Viewport(base.width,base.height).focus(2,x-base.left,y-base.top);
    active=true;controls.hidden=false;document.documentElement.classList.add('lecture-zoom-active');apply();
  }
  function zoom(delta,x,y){if(active){viewport.zoom(viewport.scale+delta,x===undefined?undefined:x-base.left,y===undefined?undefined:y-base.top);apply();}}
  function pan(dx,dy){if(active){viewport.pan(dx,dy);apply();}}
  root.addEventListener('mousedown',event=>{
    if(!matchesModifier(event)||event.button!==0)return;
    event.preventDefault();event.stopImmediatePropagation();suppressClickUntil=Date.now()+300;
    if(active)reset();else enter(event.clientX,event.clientY);
  },true);
  root.addEventListener('click',event=>{
    if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  root.addEventListener('pointerdown',event=>{
    if(!active||matchesModifier(event)||event.button!==0||event.target.closest('button,a,input,textarea,select,[contenteditable]'))return;
    drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,originX:viewport.x,originY:viewport.y,moved:false};
    root.setPointerCapture(event.pointerId);root.classList.add('viewport-dragging');event.preventDefault();event.stopPropagation();
  },true);
  root.addEventListener('pointermove',event=>{
    if(!active||!drag||drag.id!==event.pointerId)return;
    const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
    if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;
    viewport.x=drag.originX+dx;viewport.y=drag.originY+dy;viewport.limit();apply();event.preventDefault();
  });
  function finishDrag(event){
    if(!drag||drag.id!==event.pointerId)return;
    if(drag.moved)suppressClickUntil=Date.now()+300;
    if(root.hasPointerCapture(event.pointerId))root.releasePointerCapture(event.pointerId);
    drag=null;root.classList.remove('viewport-dragging');
  }
  root.addEventListener('pointerup',finishDrag);root.addEventListener('pointercancel',finishDrag);
  root.addEventListener('wheel',event=>{
    if(!active)return;
    event.preventDefault();event.stopPropagation();wheelTotal+=event.deltaY;
    if(Math.abs(wheelTotal)>=40){zoom(wheelTotal>0?-.05:.05,event.clientX,event.clientY);wheelTotal=0;}
  },{passive:false});
  controls.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||!active)return;
    const action=button.dataset.zoom,direction=button.dataset.pan;
    if(action==='less')zoom(-.05);else if(action==='more')zoom(.05);else if(action==='center'){viewport.center();apply();}else if(action==='exit')reset();
    if(direction){const step=50;pan(direction==='left'?step:direction==='right'?-step:0,direction==='up'?step:direction==='down'?-step:0);}
  });
  field.addEventListener('input',()=>{const value=Number(field.value);if(active&&field.value&&value>=100&&value<=400){viewport.zoom(value/100);apply();}});
  field.addEventListener('change',()=>{if(active){const value=Number(field.value);if(field.value&&Number.isFinite(value))viewport.zoom(value/100);apply();}});
  field.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();field.blur();}});
  window.addEventListener('keydown',event=>{
    if(!active)return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();reset();return;}
    if(event.target.closest('input,textarea,select,[contenteditable]'))return;
    const step=event.shiftKey?10:40;
    const directions={ArrowLeft:[step,0],ArrowRight:[-step,0],ArrowUp:[0,step],ArrowDown:[0,-step]};
    if(directions[event.key]){event.preventDefault();event.stopImmediatePropagation();pan(...directions[event.key]);}
    else if(['+','=','-','_'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();zoom(event.key==='-'||event.key==='_'?-.05:.05);}
    else if((event.key.toLowerCase()==='g'&&!event.ctrlKey&&!event.altKey)||(event.altKey&&event.key.toLowerCase()==='t'))reset();
  },true);
  const overlays=new MutationObserver(()=>{if(active&&document.querySelector('.classroom-window:not([hidden]),#terminal-overlay:not([hidden]),.jump-panel.open,#image-lightbox:not([hidden])'))reset();});
  overlays.observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','class']});
  window.addEventListener('resize',reset);
  Reveal.on('slidechanged',reset);Reveal.on('overviewshown',reset);
})();
