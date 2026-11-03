/* Offline course player. Course HTML and widgets remain in each course package. */
(() => {
  const cfg = window.COURSE_CONFIG || {};
  const items = typeof slides === 'undefined' ? null : slides;
  if (cfg.title) document.title = cfg.title;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (items) document.querySelector('.slides').innerHTML = items.map((slide, index) => {
    if (index === 0 && cfg.cover) return cfg.cover;
    return `<section${cfg.slideGroups ? ` data-group="${escape(slide.group)}"` : ''}><h2>${slide.title}</h2>${slide.html}</section>`;
  }).join('');
  const ui = document.createElement('div');
  ui.className = 'course-player-ui';
  ui.innerHTML = `<button id="jump-toggle" class="jump-toggle" type="button" aria-controls="jump-panel" aria-expanded="false">页面导航 <kbd>G</kbd></button>
    <aside id="jump-panel" class="jump-panel" aria-hidden="true" aria-label="页面导航"><div class="jump-head"><div><strong>快速跳转</strong><span>输入页码或标题，也可以直接选择页面</span></div><button id="jump-close" type="button" aria-label="关闭页面导航">×</button></div><input id="jump-search" type="search" placeholder="${escape(cfg.searchPlaceholder || '输入页码或标题')}" autocomplete="off"><nav id="jump-list" class="jump-list"></nav></aside><div id="jump-mask" class="jump-mask" hidden></div>
    <div id="image-lightbox" class="image-lightbox" hidden aria-hidden="true"><button type="button" aria-label="关闭大图">×</button><img alt="放大的课件图片"></div>`;
  const terminal = cfg.plugins?.terminal;
  if (terminal) ui.insertAdjacentHTML('beforeend', `<button id="terminal-toggle" class="terminal-toggle" type="button" aria-controls="terminal-overlay" aria-expanded="false">WSL终端 <kbd>Alt+T</kbd></button><div id="terminal-overlay" class="terminal-overlay" hidden aria-hidden="true"><header><div><strong>${escape(terminal.title || '本机 WSL 终端')}</strong><span>${escape(terminal.subtitle || '本地交互终端')}</span></div><button id="terminal-close" type="button">返回课件</button></header><iframe id="terminal-frame" title="本机WSL终端" data-src="${escape(terminal.url || 'http://127.0.0.1:7681/')}" allow="clipboard-read; clipboard-write"></iframe></div>`);
  document.body.append(ui);
  const sections = [...document.querySelectorAll('.slides > section')];
  const jump = ui.querySelector('#jump-panel'), search = ui.querySelector('#jump-search'), list = ui.querySelector('#jump-list'), toggle = ui.querySelector('#jump-toggle'), mask = ui.querySelector('#jump-mask');
  const titleAt = index => sections[index].querySelector('h1,h2')?.textContent.trim() || `第${index+1}页`;
  const groups = cfg.groups || [...new Set(items?.map(s => s.group || '全部页面') || ['全部页面'])].map(title => ({title, indices: sections.map((_,i) => !items || (items[i].group || '全部页面') === title ? i : -1).filter(i => i >= 0)}));
  for (const group of groups) {
    const wrapper = document.createElement('section'); wrapper.className = 'jump-group';
    const heading = document.createElement('h3'); heading.textContent = group.title; wrapper.append(heading);
    const indices = group.indices || Array.from({length:group.to-group.from+1},(_,n) => n+group.from);
    for (const index of indices.filter(i => i < sections.length)) {
      const button = document.createElement('button'); button.type='button'; button.dataset.slide=String(index); button.dataset.search=`${index+1} ${titleAt(index)} ${group.title}`.toLowerCase();
      button.innerHTML=`<span>${String(index+1).padStart(2,'0')}</span><span>${escape(titleAt(index))}</span>`;
      button.addEventListener('click',() => {Reveal.slide(index); closeNavigation();}); wrapper.append(button);
    }
    list.append(wrapper);
  }
  function filter() {
    const query=search.value.trim().toLowerCase(); let count=0;
    list.querySelectorAll('.jump-group').forEach(group => {let visible=0; group.querySelectorAll('button').forEach(button => {button.hidden=!!query&&!button.dataset.search.includes(query); if(!button.hidden)visible++;});group.hidden=!visible;count+=visible;});
    list.querySelector('.jump-empty')?.remove();
    if(!count){const empty=document.createElement('p');empty.className='jump-empty';empty.textContent='没有匹配页面';list.append(empty);}
  }
  function updateActive() {list.querySelectorAll('button[data-slide]').forEach(button => button.classList.toggle('active',Number(button.dataset.slide)===Reveal.getIndices().h));}
  function openNavigation() {jump.classList.add('open');jump.setAttribute('aria-hidden','false');toggle.setAttribute('aria-expanded','true');mask.hidden=false;search.value='';filter();updateActive();search.focus();}
  function closeNavigation() {jump.classList.remove('open');jump.setAttribute('aria-hidden','true');toggle.setAttribute('aria-expanded','false');mask.hidden=true;search.value='';filter();}
  toggle.addEventListener('click',openNavigation);ui.querySelector('#jump-close').addEventListener('click',closeNavigation);mask.addEventListener('click',closeNavigation);search.addEventListener('input',filter);
  search.addEventListener('keydown',event => {if(event.key!=='Enter')return; const n=Number(search.value.trim());if(/^\d+$/.test(search.value.trim())&&n>=1&&n<=sections.length){Reveal.slide(n-1);closeNavigation();}else list.querySelector('.jump-group:not([hidden]) button:not([hidden])')?.click();});
  const lightbox=ui.querySelector('#image-lightbox'),image=lightbox.querySelector('img');
  function closeImage(){lightbox.hidden=true;lightbox.setAttribute('aria-hidden','true');image.removeAttribute('src');}
  document.querySelectorAll('.zoomable-image').forEach(button => button.addEventListener('click',() => {image.src=button.dataset.zoomSrc;lightbox.hidden=false;lightbox.setAttribute('aria-hidden','false');}));
  lightbox.querySelector('button').addEventListener('click',closeImage);lightbox.addEventListener('click',event => {if(event.target===lightbox)closeImage();});
  window.addEventListener('keydown',event => {
    const editing=event.target.closest('input,textarea,select,[contenteditable]');
    if(event.key==='Escape'&&!lightbox.hidden){event.preventDefault();event.stopImmediatePropagation();closeImage();}
    else if(event.key==='Escape'&&jump.classList.contains('open')){event.preventDefault();event.stopImmediatePropagation();closeNavigation();}
    else if(!editing&&!event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='g'){event.preventDefault();jump.classList.contains('open')?closeNavigation():openNavigation();}
  },true);
  Reveal.initialize({width:1280,height:720,margin:0,controls:true,progress:true,history:true,center:false,hash:true,slideNumber:'c/t',transition:'fade',backgroundTransition:'fade',...cfg.reveal,plugins:[RevealHighlight]});
  Reveal.on('slidechanged',updateActive); Reveal.on('ready',updateActive);updateActive();
  if(new URLSearchParams(location.search).get('nav')==='open')openNavigation();
  window.CoursePlayer={version:'0.1.0',config:cfg,openNavigation,closeNavigation};
})();
