/* Teacher-confirmed, per-lesson classroom awards. */
window.ClassroomStars = (() => {
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clock=value=>new Date(value*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  let request,closeParent,refreshState,summary=null,selected='',saving=false,starsOnly=false;
  function coverQuiz(value){document.querySelectorAll('.embedded-head,.embedded-main,.embedded-controls').forEach(node=>node.inert=value);}
  function view(name){['candidates','poster','history'].forEach(key=>$(`star-${key}-view`).hidden=key!==name);$('stars-panel').classList.toggle('showing-poster',name==='poster');}
  function error(message){$('star-error').textContent=message;$('star-error').hidden=!message;}
  function reasonFor(c){return c.graded?`参与${c.answered}道互动题，知识题答对${c.correct}/${c.graded}题${c.improved?`，${c.improved}题在讨论后由错转对`:''}。`:`参与${c.answered}道观点题，积极表达自己的观点。`;}
  function updateConfirm(){
    const c=summary?.candidates.find(row=>row.student_id===selected);
    $('star-confirm').disabled=!c||Boolean(summary?.open_round_id)||saving||!$('star-reason').value.trim();
    $('star-confirm').textContent=saving?'正在保存…':summary?.award?'保存修订并展示':'确认并展示表彰卡';
    $('star-selection').textContent=c?`已选择 ${c.name} · 学号尾号${c.student_id.slice(-4)}`:'请选择一位同学';
  }
  function choose(student_id){
    selected=student_id;const c=summary.candidates.find(row=>row.student_id===selected);
    $('star-other').value=selected;
    document.querySelectorAll('[data-star-student]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.starStudent===selected)));
    $('star-reason').value=c?reasonFor(c):'';updateConfirm();
  }
  function candidates(){
    view('candidates');error('');selected='';
    $('star-lesson-title').textContent=summary.lesson.title;
    $('star-scope').textContent=`${summary.total_questions}道已截止互动 · ${summary.candidates.length}人参与 · ${clock(summary.lesson.started)}起统计`;
    $('star-open-note').hidden=!summary.open_round_id;
    $('star-empty').hidden=Boolean(summary.candidates.length);
    $('star-selection-form').hidden=!summary.candidates.length;
    $('star-grid').innerHTML=summary.recommended_ids.map(id=>{
      const c=summary.candidates.find(row=>row.student_id===id);
      const tag=c.improved?'讨论后有进步':c.graded&&c.correct===c.graded?'知识题全部答对':'积极参与';
      return `<button type="button" class="star-candidate" data-star-student="${esc(id)}" aria-pressed="false"><span class="star-candidate-tag">${esc(tag)}</span><strong>${esc(c.name)}</strong><small>学号尾号 ${esc(id.slice(-4))}</small><span class="star-candidate-metrics"><span><b>${c.answered}/${summary.total_questions}</b>参与</span><span><b>${c.graded?`${c.correct}/${c.graded}`:'—'}</b>知识题答对</span><span><b>${c.improved}题</b>由错转对</span></span><span class="star-select-label">选择这位同学</span></button>`;
    }).join('');
    $('star-other').innerHTML='<option value="">从全部参与同学中选择…</option>'+summary.candidates.map(c=>`<option value="${esc(c.student_id)}">${esc(c.name)} · 尾号${esc(c.student_id.slice(-4))} · 参与${c.answered}题</option>`).join('');
    $('star-reason').value='';updateConfirm();
    (document.querySelector('[data-star-student]')||$('star-new-lesson')).focus();
  }
  function poster(award){
    view('poster');error('');const snapshot=award.snapshot,c=snapshot.candidate;
    $('star-winner').textContent=award.name;$('star-praise').textContent=award.reason;
    $('star-poster-lesson').textContent=snapshot.lesson.title;
    $('star-poster-participation').textContent=`${c.answered}/${snapshot.total_questions}`;
    $('star-poster-correct').textContent=c.graded?`${c.correct}/${c.graded}`:'—';
    $('star-poster-improved').textContent=`${c.improved}题`;
    $('star-save-note').textContent=`教师确认 · ${clock(award.confirmed)} · 记录 #${award.id}${award.version>1?` · 第${award.version}版`:''}`;
    $('star-poster-candidates').focus();
  }
  function history(){
    view('history');error('');
    $('star-history-list').innerHTML=summary.history.length?summary.history.map(award=>`<button class="star-history-item" data-star-award="${award.id}"><span><small>${esc(award.snapshot.lesson.title)}</small><strong>${esc(award.name)} · 课堂之星</strong><span>${esc(award.reason)}</span></span><b>展示表彰卡 →</b></button>`).join(''):'<p class="star-empty-note">尚无教师确认的表彰记录。</p>';
  }
  async function load(showSaved=true){
    error('');summary=await request('/api/stars');
    if(showSaved&&summary.award)poster(summary.award);else candidates();
  }
  async function show(){
    document.querySelectorAll('.embedded-tool').forEach(panel=>panel.hidden=true);$('stars-panel').hidden=false;coverQuiz(true);
    try{await load();}catch(e){view('candidates');error(e.message);}
  }
  function close(){if(starsOnly)closeParent();else{$('stars-panel').hidden=true;coverQuiz(false);$('show-stars').focus();}}
  function init(options){
    request=options.request;closeParent=options.closeParent;refreshState=options.refresh;starsOnly=options.starsOnly;
    $('show-stars').addEventListener('click',show);
    document.querySelectorAll('[data-stars-close]').forEach(button=>button.addEventListener('click',close));
    $('star-grid').addEventListener('click',event=>{const button=event.target.closest('[data-star-student]');if(button)choose(button.dataset.starStudent);});
    $('star-other').addEventListener('change',()=>choose($('star-other').value));
    $('star-reason').addEventListener('input',updateConfirm);
    $('star-refresh').addEventListener('click',()=>load(false).catch(e=>error(e.message)));
    $('star-show-history').addEventListener('click',()=>{if(summary)history();});
    $('star-poster-history').addEventListener('click',()=>{if(summary)history();});
    $('star-history-back').addEventListener('click',()=>load().catch(e=>error(e.message)));
    $('star-poster-candidates').addEventListener('click',()=>load(false).catch(e=>error(e.message)));
    $('star-history-list').addEventListener('click',event=>{const b=event.target.closest('[data-star-award]');if(b)poster(summary.history.find(a=>a.id===Number(b.dataset.starAward)));});
    $('star-close-round').addEventListener('click',async()=>{
      if(!summary?.open_round_id)return;
      try{await request('/api/action',{round_id:summary.open_round_id,action:'close'});await refreshState();await load(false);}catch(e){error(e.message);}
    });
    $('star-selection-form').addEventListener('submit',async event=>{
      event.preventDefault();if(saving||!selected||summary.open_round_id)return;
      saving=true;updateConfirm();error('');
      try{
        const result=await request('/api/star/confirm',{confirmed:true,lesson_id:summary.lesson.id,revision:summary.revision,student_id:selected,reason:$('star-reason').value.trim(),replace:Boolean(summary.award)});
        summary.award=result.award;summary.history=[result.award,...summary.history.filter(a=>a.lesson_id!==result.award.lesson_id)];poster(result.award);
      }catch(e){error(e.message);}finally{saving=false;updateConfirm();}
    });
    $('star-new-lesson').addEventListener('click',async()=>{
      if(!confirm('开始新课次？本节统计范围将结束，原有答题与表彰记录保留。'))return;
      try{await request('/api/lesson/start',{});await load(false);}catch(e){error(e.message);}
    });
    return {show,close};
  }
  return {init};
})();
