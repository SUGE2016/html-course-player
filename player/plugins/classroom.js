(() => {
  const settings=window.COURSE_CONFIG?.plugins?.classroom;
  if(!settings)return;
  const points=settings.points || [];
  const serviceOrigin=new URL(settings.origin).origin;
  const chapter=window.COURSE_CONFIG.chapter;
  const style = document.createElement('style');
  style.textContent = `
    .reveal h2.has-classroom-points{display:flex;align-items:center;justify-content:space-between;gap:20px}
    .classroom-points{display:flex;flex-shrink:0;gap:8px;align-items:center;line-height:1}
    .classroom-point{display:inline-flex;gap:7px;align-items:center;border:1px solid #9ccbdc;border-radius:6px;background:#f1fbff;color:#145578;font:600 16px/1.35 'Microsoft YaHei',sans-serif;padding:8px 10px;cursor:pointer}
    .classroom-point::before{content:'?';display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#087eae;color:white;font:700 14px Arial}
    .classroom-point:hover,.classroom-point:focus-visible{background:#def5fd;border-color:#087eae}
    .classroom-star-toggle{border:1px solid #b6c7d7;background:rgba(255,255,255,.94);color:#142d43;cursor:pointer}.classroom-star-toggle span{color:#a77c28}
    .classroom-toolbar{--toolbar-left:18px;position:fixed;left:var(--toolbar-left);bottom:22px;z-index:30;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 36px);transition:transform .18s ease}
    .classroom-toolbar-items{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;order:1}
    .classroom-toolbar button{position:static;left:auto;bottom:auto;display:inline-flex;align-items:center;justify-content:center;gap:10px;flex-shrink:0;box-sizing:border-box;height:44px;padding:0 14px;border-radius:7px;font:700 15px/1.25 'Microsoft YaHei',sans-serif;white-space:nowrap;box-shadow:0 5px 18px rgba(11,31,51,.12)}
    .classroom-toolbar button kbd{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:23px;min-width:23px;margin:0;padding:0 6px;font:13px/1 Consolas,monospace}
    .classroom-toolbar .classroom-toolbar-collapse{order:2;width:28px;padding:0;background:rgba(255,255,255,.94);color:#29465b;border:1px solid #b6c7d7;font-size:24px;cursor:pointer}
    .classroom-toolbar.is-collapsed{transform:translateX(calc(-100% + 28px - var(--toolbar-left)))}
    .classroom-toolbar.is-collapsed .classroom-toolbar-collapse{border-radius:0 7px 7px 0}
    .classroom-toolbar .classroom-star-toggle span{display:inline-flex;align-items:center;line-height:1;font-size:17px}
    @media(max-width:520px){.classroom-toolbar{--toolbar-left:12px;bottom:12px;gap:7px;max-width:calc(100vw - 24px)}.classroom-toolbar-items{gap:7px}.classroom-toolbar button{height:40px;padding:0 10px;gap:7px;font-size:13px}.classroom-toolbar button kbd{height:21px;font-size:11px}.classroom-toolbar .classroom-toolbar-collapse{padding:0;font-size:24px}}
    @media(prefers-reduced-motion:reduce){.classroom-toolbar{transition:none}}
    .classroom-mask{position:fixed;inset:0;background:#071a2c55;z-index:89}
    .classroom-window{position:fixed;top:5vh;right:2vw;width:min(1000px,82vw);height:90vh;z-index:90;border:1px solid #a3bfce;border-radius:11px;box-shadow:0 20px 90px #05162766;background:white;display:grid;grid-template-rows:48px minmax(0,1fr);overflow:hidden;color:#10283f;font-family:'Microsoft YaHei',sans-serif}
    .classroom-window[hidden],.classroom-mask[hidden]{display:none!important}
    .classroom-window>header{display:flex;align-items:center;justify-content:space-between;gap:15px;background:#eef6fa;border-bottom:1px solid #d6e4ed;padding:0 17px;font-size:15px}
    .classroom-window>header strong{font-size:16px}
    .classroom-window>header button{padding:6px 11px;background:white;border:1px solid #b9cbd6;color:#193d56;border-radius:6px;font:600 14px 'Microsoft YaHei',sans-serif;cursor:pointer}
    .classroom-window iframe{width:100%;height:100%;border:0;background:white;min-height:0}
    .classroom-offline{position:absolute;inset:48px 0 0;padding:70px 35px;background:white;text-align:center;font-size:19px;line-height:1.8}
    .classroom-offline[hidden]{display:none!important}
    .classroom-offline button{font:inherit;color:white;background:#087eae;border:0;border-radius:6px;padding:8px 18px;cursor:pointer}
    @media(max-width:800px){.classroom-window{width:96vw;right:2vw;height:94vh;top:3vh}}
    @media print{.classroom-points,.classroom-window,.classroom-mask,.classroom-toolbar{display:none!important}}
  `;
  document.head.append(style);
  const mask = document.createElement('div'); mask.className='classroom-mask';mask.hidden=true;
  const panel = document.createElement('section');panel.className='classroom-window';panel.hidden=true;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-label','本页课堂提问');panel.setAttribute('aria-modal','true');
  panel.innerHTML='<header><strong>本页课堂提问</strong><button type="button" data-close>收起，继续讲课 · Esc</button></header><iframe title="课件内提问与实时统计"></iframe><div class="classroom-offline" hidden><p>课堂互动服务尚未连接。</p><p>请启动配置的互动服务，并确认 course.js 中的服务地址。</p><button type="button">重新连接</button></div>';
  const starToggle=document.createElement('button');starToggle.type='button';starToggle.className='classroom-star-toggle';starToggle.innerHTML='<span>★</span>课堂之星';starToggle.title='课末评选与表彰记录';
  const toolbar=document.createElement('div');toolbar.className='classroom-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','课堂工具');
  const toolbarItems=document.createElement('div');toolbarItems.className='classroom-toolbar-items';toolbarItems.id='classroom-toolbar-items';
  toolbarItems.append(...[document.querySelector('#jump-toggle'),document.querySelector('#terminal-toggle'),starToggle].filter(Boolean));
  const toolbarCollapse=document.createElement('button');toolbarCollapse.type='button';toolbarCollapse.className='classroom-toolbar-collapse';toolbarCollapse.setAttribute('aria-controls',toolbarItems.id);
  toolbar.append(toolbarCollapse,toolbarItems);
  document.body.append(mask,panel,toolbar);
  let toolbarCollapsed=false;
  try{toolbarCollapsed=localStorage.getItem('html-course-player-toolbar-collapsed')==='1';}catch{}
  function setToolbarCollapsed(value,persist=true){
    toolbarCollapsed=value;toolbar.classList.toggle('is-collapsed',value);toolbarItems.inert=value;
    toolbarItems.setAttribute('aria-hidden',String(value));toolbarCollapse.setAttribute('aria-expanded',String(!value));
    toolbarCollapse.textContent=value?'›':'‹';
    toolbarCollapse.title=value?'展开课堂工具栏':'向左收起课堂工具栏';
    toolbarCollapse.setAttribute('aria-label',toolbarCollapse.title);
    if(persist)try{localStorage.setItem('html-course-player-toolbar-collapsed',value?'1':'0');}catch{}
  }
  toolbarCollapse.addEventListener('click',()=>setToolbarCollapsed(!toolbarCollapsed));
  setToolbarCollapsed(toolbarCollapsed,false);
  const frame=panel.querySelector('iframe'),offline=panel.querySelector('.classroom-offline');
  let trigger=null, previousKeyboard=true, readyTimer=null, lastTarget='';
  function close() {
    panel.hidden=true;mask.hidden=true;clearTimeout(readyTimer);
    if(document.querySelector('#terminal-overlay')?.hidden !== false)Reveal.configure({keyboard:previousKeyboard});
    trigger?.focus({preventScroll:true});
  }
  function open(point,button,starsOnly=false) {
    if(document.querySelector('#terminal-overlay')?.hidden === false)document.querySelector('#terminal-close')?.click();
    if(panel.hidden)previousKeyboard=Reveal.getConfig().keyboard;
    trigger=button;panel.hidden=false;mask.hidden=false;offline.hidden=true;
    panel.querySelector('header strong').textContent=starsOnly?'课末表彰 · 课堂之星':`第${point[0]}页提问 · ${point[2]}`;
    Reveal.configure({keyboard:false});
    const target=`${serviceOrigin}/embedded?chapter=${encodeURIComponent(chapter)}&page=${point[0]}&${starsOnly?'mode=stars':'question='+encodeURIComponent(point[1])}`;
    clearTimeout(readyTimer);
    if(lastTarget!==target || !frame.src) {
      lastTarget=target;frame.src=target;
      readyTimer=setTimeout(()=>{offline.hidden=false;},6000);
    }else if(starsOnly){frame.contentWindow.postMessage({type:'classroom:stars-open'},serviceOrigin);}
    panel.querySelector('[data-close]').focus({preventScroll:true});
  }
  points.forEach(point=>{
    const slide=document.querySelectorAll('.slides>section')[point[0]-1],heading=slide?.querySelector('h2');
    if(!heading)return;
    let group=heading.querySelector('.classroom-points');
    if(!group){group=document.createElement('span');group.className='classroom-points';group.setAttribute('aria-label','本页提问点');heading.append(group);heading.classList.add('has-classroom-points');}
    const button=document.createElement('button');button.type='button';button.className='classroom-point';button.textContent=point[2];button.dataset.question=point[1];
    button.title=`点击发起：${point[2]}`;
    button.addEventListener('click',()=>open(point,button));group.append(button);
  });
  panel.querySelector('[data-close]').addEventListener('click',close);
  starToggle.addEventListener('click',()=>open([Reveal.getIndices().h+1,'','课堂之星'],starToggle,true));
  mask.addEventListener('click',close);
  offline.querySelector('button').addEventListener('click',()=>{lastTarget='';if(trigger===starToggle)open([Reveal.getIndices().h+1,'','课堂之星'],starToggle,true);else if(trigger)open(points.find(point=>point[1]===trigger.dataset.question),trigger);});
  window.addEventListener('message',event=>{
    if(event.source!==frame.contentWindow || event.origin!==serviceOrigin)return;
    if(event.data?.type==='classroom:ready'){clearTimeout(readyTimer);offline.hidden=true;}
    if(event.data?.type==='classroom:close')close();
  });
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!panel.hidden){event.preventDefault();event.stopImmediatePropagation();close();}
    else if(event.altKey&&event.key.toLowerCase()==='q'&&!event.target.closest('input,textarea,select,[contenteditable]')){
      event.preventDefault();event.stopImmediatePropagation();
      if(!panel.hidden){close();return;}
      const page=Reveal.getIndices().h+1,point=points.find(item=>item[0]===page);
      if(point){const button=document.querySelector(`.slides>section:nth-child(${page}) [data-question="${point[1]}"]`);open(point,button);}
    }else if(event.altKey&&event.key.toLowerCase()==='t'&&!panel.hidden)close();
  },true);
})();
