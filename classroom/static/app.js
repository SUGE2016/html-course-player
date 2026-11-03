"use strict";
const view = document.body.dataset.view;
const isDisplay = view === 'projector' || view === 'embedded';
const $ = id => document.getElementById(id);
const e = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const letters = "ABCDEF";
const kindName = kind => ({choice:"单项选择",tf:"判断题",poll:"观点选择"}[kind] || "课堂提问");
const roundNumber = round => Number.isInteger(round?.round_number) ? round.round_number : (round?.previous_id ? 2 : 1);
const roundLabel = round => `第${roundNumber(round)}轮`;
let state = null, connected = false, offset = 0, questions = [], pageTitles = {}, selectedQuestion = null;
let selectedChoice = null, seenRound = null, pollPending = false, actionPending = false;
let questionRenderKey = "", chartRenderKey = "", teacherRenderKey = "", studentListKey = "", historyKey = "";
let pointTarget = null, pointError = '';
let roundReview = null;
let identitySwitch = false, rosterEnabled = false, lookupVersion = 0, lookupTimer = null, guardBlocked = false, untrustedAction = false;

function clientInfo() {
  return {webdriver:navigator.webdriver === true, untrusted_action:untrustedAction, language:navigator.language || '', timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || '', screen:`${screen.width}x${screen.height}`, platform:navigator.platform || ''};
}
function showGuard(message, blocked = false) {
  if (!$('guard-note')) return;
  guardBlocked = guardBlocked || blocked;
  $('guard-note').hidden = false; $('guard-note').classList.toggle('blocked',guardBlocked);
  $('guard-note').textContent = message;
  $('join-submit').disabled = guardBlocked;
  if(guardBlocked){document.querySelectorAll('.student-option').forEach(button=>button.disabled=true);$('student-room').hidden=true;$('join-form').hidden=true;}
  updateSubmit();
}

async function api(path, data) {
  if(view==='student' && data !== undefined) data = {...data,client:clientInfo()};
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 6000);
  try {
    const response = await fetch(path, {method:data === undefined ? "GET" : "POST", headers:data === undefined ? {} : {"Content-Type":"application/json"}, body:data === undefined ? undefined : JSON.stringify(data), credentials:"same-origin", cache:"no-store", signal:control.signal});
    const result = await response.json();
    if (!response.ok) {
      if(result.automation_blocked)showGuard(result.error,true);
      throw new Error(result.error || "请求失败，请重试。");
    }
    return result;
  } catch(error) {
    if (error.name === "AbortError" || error instanceof TypeError) throw new Error("连接中断，请确认课堂服务和网络连接。");
    throw error;
  } finally { clearTimeout(timer); }
}

function toast(message) {
  if (!$('toast')) return;
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function connection(ok) {
  connected = ok;
  const indicator = $('connection');
  indicator.textContent = ok ? "已连接 · 自动刷新" : "连接中断 · 正在重连";
  indicator.classList.toggle('offline', !ok);
  if (view === 'student') updateSubmit();
}

function remaining(round) {
  return round && round.status === 'open' ? Math.max(0, Math.ceil(round.deadline - (Date.now()/1000 + offset))) : 0;
}

function statusText(round) {
  return !round ? '等待发题' : round.status === 'open' ? '正在作答' : round.status === 'revealed' ? (round.question.kind === 'poll' ? '已公布分布' : '已公布答案') : '本轮已结束';
}

function renderRoundControls(round) {
  const open = round?.status === 'open';
  $('close-round').hidden = !round || !open;
  $('close-round').disabled = !round || !open;
  setText('close-round', round ? `结束${roundLabel(round)}` : '结束本轮');
  $('repeat').hidden = !round || open;
  $('repeat').disabled = !round || open;
  setText('repeat', round ? `再答一轮 · 第${roundNumber(round)+1}轮` : '再答一轮');
  $('repeat').title = '新一轮重新作答，上一轮答案和记录保留。';
}

function codeBlock(code, id = '') {
  return code ? `<pre ${id ? `id="${id}"` : ''} class="code-block">${e(code)}</pre>` : '';
}

function optionsMarkup(q, cls = 'preview-options') {
  return `<div class="${cls}">${q.options.map((option,index) => `<div><b>${letters[index]}</b>${e(option)}</div>`).join('')}</div>`;
}

function chart(container, round) {
  if (!round) { container.replaceChildren(); return; }
  if (!Array.isArray(round.counts)) {
    container.innerHTML = (isDisplay ? optionsMarkup(round.question,'projector-options') : '') + '<p class="empty-note">答案分布暂不显示</p>';
    return;
  }
  const total = round.counts.reduce((a,b) => a+b,0);
  const previousTotal = (round.previous_counts || []).reduce((a,b) => a+b,0);
  container.innerHTML = `<div class="chart">${round.question.options.map((option,index) => {
    const n = round.counts[index], percent = total ? n/total*100 : 0;
    const correct = round.status === 'revealed' && round.question.answer === index;
    const previous = round.previous_counts ? `<div class="bar-previous">第${roundNumber(round)-1}轮 ${(round.previous_counts[index] || 0)} 人 · ${previousTotal ? Math.round(round.previous_counts[index]/previousTotal*100) : 0}%</div>` : '';
    return `<div class="bar-row${correct ? ' correct' : ''}"><span class="bar-key">${letters[index]}</span><div class="bar-body"><div class="bar-label">${e(option)}</div><div class="bar-track" role="img" aria-label="${letters[index]} ${n}人 ${Math.round(percent)}%"><div class="bar-fill" style="width:${percent}%"></div></div>${previous}</div><span class="bar-value">${n} 人 · ${Math.round(percent)}%</span></div>`;
  }).join('')}</div>${total ? '' : '<p class="subtle">尚未收到答案。</p>'}`;
}

function answerMarkup(round, teacher = false) {
  const q = round.question;
  if (q.kind === 'poll') return `<strong>观点说明</strong>${e(q.explanation || '本题用于了解观点，没有标准答案。')}`;
  return `<strong>${teacher && round.status !== 'revealed' ? '教师可见 · ' : ''}正确答案 ${letters[q.answer]}：${e(q.options[q.answer])}</strong><span>${e(q.explanation)}</span>`;
}

function setText(id, value) { if ($(id)) $(id).textContent = value; }

function renderBank() {
  if (!state) return;
  const query = $('question-search').value.trim().toLowerCase();
  const eligible = questions.filter(q => q.chapter === state.chapter && q.page === state.progress);
  const matches = eligible.filter(q => (q.title + q.code + q.options.join(' ')).toLowerCase().includes(query));
  setText('question-count', `${eligible.length}题`);
  setText('progress-note', `${state.chapter} 第${state.progress}页${pageTitles[state.chapter]?.[state.progress] ? ' · ' + pageTitles[state.chapter][state.progress] : ''}`);
  if (selectedQuestion && !eligible.some(q=>q.id===selectedQuestion.id)) {
    selectedQuestion = null;
    $('preview').innerHTML = '<p class="empty-note">选择一题，预览后发给学生。</p>';
    setText('preview-meta','从左侧选择');
  }
  $('question-list').innerHTML = matches.length ? matches.map(q => `<button class="question-item${selectedQuestion?.id===q.id?' active':''}" data-q="${e(q.id)}"><small>${kindName(q.kind)} · 第${q.page}页</small>${e(q.title)}</button>`).join('') : `<p class="empty-note">${eligible.length ? '没有匹配的题目。' : '此页暂未配置题目，可使用下方“临时出题”。'}</p>`;
  $('launch').disabled = !selectedQuestion || state.round?.status === 'open' || !connected;
}

function preview(q) {
  selectedQuestion = q;
  $('preview').innerHTML = `<h3 class="preview-title">${e(q.title)}</h3>${codeBlock(q.code)}${optionsMarkup(q)}<p class="subtle">${q.kind === 'poll' ? '观点选择，无标准答案。' : `教师预览：正确选项 ${letters[q.answer]}。解析在公布后向学生展示。`}</p>`;
  setText('preview-meta',`${q.chapter} P${q.page} · ${kindName(q.kind)}`);
  renderBank();
}

function renderTeacher() {
  const r = state.round;
  setText('session-title', state.title);
  setText('joined-count', state.joined);
  setText('submitted-count', r?.submitted || 0);
  setText('round-status', r ? `${roundLabel(r)} · ${statusText(r)}` : statusText(r));
  setText('student-count', `（${state.joined}人）`);
  const key = `${state.session_id}:${state.chapter}:${state.progress}`;
  if (teacherRenderKey !== key) {
    if(![...$('chapter').options].some(option=>option.value===state.chapter))$('chapter').add(new Option(state.chapter,state.chapter));
    $('chapter').value = state.chapter; $('progress').value = state.progress;
    teacherRenderKey = key; renderBank();
  }
  $('launch').disabled = !selectedQuestion || r?.status === 'open' || !connected;
  renderRoundControls(r);
  $('reveal').disabled = !r;
  $('toggle-live').disabled = !r;
  setText('toggle-live', r?.show_live ? '隐藏投屏分布' : '实时显示投屏分布');
  setText('reveal', answerButtonText(r));
  if (questionRenderKey !== `${r?.id}:${r?.status}`) {
    questionRenderKey = `${r?.id}:${r?.status}`;
    $('current-question').innerHTML = r ? `<p class="current-title">${e(r.question.title)}</p>${codeBlock(r.question.code)}` : '<p class="empty-note">尚未发题。学生加入后会自动收到你发起的题目。</p>';
    $('teacher-answer').hidden = !r || r.status !== 'revealed';
    if (r) $('teacher-answer').innerHTML = answerMarkup(r,true);
  }
  const chartKey = JSON.stringify(r && [r.id,r.status,r.counts,r.previous_counts]);
  if (chartRenderKey !== chartKey) { chartRenderKey = chartKey; chart($('chart'),r); }
  const studentsKey = JSON.stringify(state.students);
  if (studentListKey !== studentsKey) {
    studentListKey = studentsKey;
    $('student-list').innerHTML = state.students.length ? state.students.map(s=>`<div class="student-row"><span>${e(s.name)}</span><code>${e(s.student_id)}</code><button class="text-button" data-unbind="${e(s.student_id)}">解除绑定</button></div>`).join('') : '<p class="subtle">尚无学生加入。</p>';
  }
  const hkey = JSON.stringify(state.history);
  if (historyKey !== hkey) {
    historyKey = hkey;
    $('history').innerHTML = state.history.length ? state.history.map(h=>`<div class="history-row"><span>#${h.id} · ${roundLabel(h)} ${e(h.title)}</span><span>${h.submitted}人作答</span></div>`).join('') : '<p class="subtle">暂无提问记录。</p>';
  }
}

function updateSubmit() {
  if (!$('submit-vote')) return;
  const r = state?.round;
  const closed = !r || r.status !== 'open' || remaining(r) <= 0;
  $('submit-vote').disabled = guardBlocked || identitySwitch || !connected || actionPending || closed || selectedChoice === null || selectedChoice === r?.my_choice;
  setText('submit-vote', r?.my_choice === undefined || r?.my_choice === null ? '提交答案' : '更新答案');
}

function renderStudent() {
  const me = state.me, r = state.round;
  setText('join-title',state.title);
  $('join-panel').hidden = Boolean(me) && !identitySwitch; $('student-room').hidden = !me || identitySwitch;
  if (!me) { seenRound = null; selectedChoice = null; return; }
  setText('class-title',state.title);
  setText('student-identity',`${me.name} · ${me.student_id}`);
  setText('student-status',r ? `${roundLabel(r)} · ${statusText(r)}` : statusText(r));
  $('waiting-panel').hidden = Boolean(r); $('student-question-panel').hidden = !r;
  if (!r) return;
  if (seenRound !== r.id) { seenRound = r.id; selectedChoice = r.my_choice ?? null; questionRenderKey = ''; chartRenderKey = ''; }
  if (questionRenderKey !== `${r.id}:${r.status}`) {
    questionRenderKey = `${r.id}:${r.status}`;
    setText('question-meta', `${r.question.chapter} P${r.question.page} · ${kindName(r.question.kind)} · ${roundLabel(r)}`);
    setText('student-question-title',r.question.title);
    setText('student-code',r.question.code); $('student-code').hidden = !r.question.code;
    $('student-options').innerHTML = r.question.options.map((option,index)=>`<button class="student-option" type="button" data-choice="${index}" aria-pressed="false"><b>${letters[index]}</b><span>${e(option)}</span></button>`).join('');
    $('student-result').hidden = r.status !== 'revealed';
    if (r.status === 'revealed') $('student-result').innerHTML = answerMarkup(r);
  }
  const closed = r.status !== 'open' || remaining(r)<=0;
  $('student-options').querySelectorAll('button').forEach(button=>{
    const choice = Number(button.dataset.choice);
    button.disabled = closed || guardBlocked;
    button.classList.toggle('selected',selectedChoice===choice);
    button.classList.toggle('submitted',r.my_choice===choice);
    button.classList.toggle('correct',r.status==='revealed'&&r.question.answer===choice);
    button.setAttribute('aria-pressed',String(selectedChoice===choice));
  });
  setText('vote-status',r.my_choice !== null && r.my_choice !== undefined ? `已提交 ${letters[r.my_choice]}${closed ? '，答案已锁定。' : '，截止前可修改。'}` : closed ? '本题已截止，你未提交答案。' : selectedChoice===null ? '选择一个选项后提交。' : `已选择 ${letters[selectedChoice]}，请提交。`);
  const ck = JSON.stringify([r.id,r.status,r.counts,r.previous_counts]);
  if (chartRenderKey!==ck) { chartRenderKey=ck; if(r.status==='revealed') chart($('student-chart'),r); else $('student-chart').replaceChildren(); }
  updateSubmit();
}

function renderProjector() {
  const r = state.round;
  if (view === 'embedded' && (!r || r.question.id !== pointTarget?.question_id)) {
    $('projector-waiting').hidden = false; $('projector-round').hidden = true;
    setText('projector-joined', state.joined); setText('projector-submitted', 0);
    const conflict = Boolean(r && r.status === 'open');
    setText('embedded-waiting-title', conflict ? '上一题仍在作答' : '本页提问尚未发起');
    setText('embedded-waiting-detail', pointError || '点击重新连接，发起当前提问点。');
    $('switch-point').hidden = !conflict; $('retry-point').hidden = conflict;
    renderRoundControls(null);
    ['close-round','toggle-live','reveal','repeat'].forEach(id => $(id).disabled = true);
    return;
  }
  document.body.classList.toggle('comparing', Boolean(r?.previous_id));
  setText('projector-session',state.title);
  setText('projector-meta', r ? `${r.question.chapter} 第${r.question.page}页 · ${kindName(r.question.kind)} · ${roundLabel(r)} · ${statusText(r)}` : '等待教师发起提问');
  setText('projector-submitted',r?.submitted || 0); setText('projector-joined',state.joined);
  $('projector-waiting').hidden = Boolean(r); $('projector-round').hidden = !r;
  if (!r) { if(view==='embedded')renderRoundControls(null); return; }
  if (questionRenderKey !== `${r.id}:${r.status}`) {
    questionRenderKey = `${r.id}:${r.status}`;
    setText('projector-title',r.question.title);
    setText('projector-code',r.question.code); $('projector-code').hidden = !r.question.code;
    document.querySelector('.projector-columns').classList.toggle('no-code', !r.question.code);
    $('projector-options').hidden = true;
    $('projector-answer').hidden = r.status !== 'revealed';
    if (r.status==='revealed') $('projector-answer').innerHTML = answerMarkup(r);
  }
  const ck = JSON.stringify([r.id,r.status,r.counts,r.previous_counts]);
  if (chartRenderKey!==ck) { chartRenderKey=ck; chart($('projector-chart'),r); }
  if (view === 'embedded') {
    renderRoundControls(r);
    $('reveal').disabled = false;
    $('toggle-live').disabled = false;
    setText('toggle-live', r.show_live ? '隐藏分布' : '显示分布');
    setText('reveal', answerButtonText(r));
  }
}

function tick() {
  const r=state?.round, n=r ? remaining(r) : '—';
  setText(view==='teacher'?'countdown':view==='student'?'student-countdown':'projector-countdown',n);
  if (view==='student'&&r&&remaining(r)===0) updateSubmit();
}

async function refresh() {
  if(view==='student'&&guardBlocked)return;
  if (pollPending) return;
  pollPending=true;
  try {
    state = await api(isDisplay?'/api/projector':'/api/state');
    offset=state.server_time-Date.now()/1000;
    connection(true);
    if(view==='teacher') renderTeacher(); else if(view==='student') renderStudent(); else renderProjector();
    roundReview?.update(view==='embedded' && state.round?.question.id!==pointTarget?.question_id ? null : state.round);
    tick();
  } catch(error) { connection(false); }
  finally { pollPending=false; }
}

async function action(path,data,success='') {
  if (actionPending) return;
  actionPending=true; updateSubmit();
  try { await api(path,data); if(success)toast(success); await refresh(); }
  catch(error) { toast(error.message); }
  finally { actionPending=false; updateSubmit(); }
}

function seconds() { return Number($('duration').value); }
function roundAction(name) { if(state?.round) action('/api/action',{action:name,round_id:state.round.id,seconds:seconds()}); }
function answerButtonText(round) {
  const content=round?.question.kind==='poll'?'观点说明':'答案与解析';
  return `${round?.status==='revealed'?'隐藏':'显示'}${content}`;
}
function toggleAnswer() { roundAction(state?.round?.status==='revealed'?'hide-answer':'reveal'); }

async function initTeacher() {
  const [bank,config] = await Promise.all([api('/api/questions'),api('/api/config')]);
  questions=bank.questions; pageTitles=bank.page_titles; setText('student-url',config.student_url);
  $('chapter').innerHTML=[...new Set(['Demo',...questions.map(q=>q.chapter)])].map(chapter=>`<option>${e(chapter)}</option>`).join('');
  const params=new URLSearchParams(location.search), chapter=params.get('chapter'), page=Number(params.get('page'));
  if (/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(chapter||'')&&Number.isInteger(page)&&page>=1&&page<=200) await api('/api/progress',{chapter,progress:page});
  $('copy-address').addEventListener('click',async()=>{
    try { await navigator.clipboard.writeText(config.student_url);toast('地址已复制。'); } catch { toast(`学生地址：${config.student_url}`); }
  });
  $('progress-form').addEventListener('submit',event=>{event.preventDefault();action('/api/progress',{chapter:$('chapter').value,progress:Number($('progress').value)});});
  $('question-search').addEventListener('input',renderBank);
  $('question-list').addEventListener('click',event=>{const button=event.target.closest('[data-q]');if(button)preview(questions.find(q=>q.id===button.dataset.q));});
  $('launch').addEventListener('click',()=>{if(selectedQuestion)action('/api/start',{question_id:selectedQuestion.id,seconds:seconds()});});
  $('close-round').addEventListener('click',()=>roundAction('close'));
  $('toggle-live').addEventListener('click',()=>roundAction('live'));
  $('reveal').addEventListener('click',toggleAnswer);
  $('repeat').addEventListener('click',()=>roundAction('repeat'));
  $('new-session').addEventListener('click',()=>{
    const title=prompt('新课堂名称（本堂旧记录保留，学生须重新加入）',`课堂互动 · ${new Date().toLocaleDateString('zh-CN')}`);
    if(title?.trim())action('/api/new-session',{title:title.trim()},'新课堂已建立，旧记录保留在本机。');
  });
  $('student-list').addEventListener('click',event=>{
    const button=event.target.closest('[data-unbind]');
    if(button&&confirm(`解除学号 ${button.dataset.unbind} 的浏览器绑定？仅尚未作答的登记可解除。`))action('/api/unbind',{student_id:button.dataset.unbind});
  });
  $('custom-kind').addEventListener('change',()=>{
    const kind=$('custom-kind').value;
    $('custom-answer-label').hidden=kind==='poll';
    if(kind==='tf')$('custom-options').value='正确\n错误';
  });
  $('custom-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(!state)return;
    action('/api/start',{seconds:seconds(),question:{title:$('custom-title').value,kind:$('custom-kind').value,options:$('custom-options').value.split('\n').map(x=>x.trim()).filter(Boolean),answer:Number($('custom-answer').value),explanation:$('custom-explanation').value,code:$('custom-code').value,chapter:state.chapter,page:state.progress}});
  });
}

function initStudent() {
  async function lookupName() {
    if(!rosterEnabled)return true;
    const student_id=$('student-id').value.trim(), version=++lookupVersion;
    if(!/^[A-Za-z0-9_-]{3,32}$/.test(student_id)){setText('roster-name','请输入完整学号，3至32位');return false;}
    setText('roster-name','正在关联点名册…');
    try {
      const found=await api('/api/lookup',{student_id});
      if(version!==lookupVersion || $('student-id').value.trim()!==student_id)return false;
      setText('roster-name',`姓名：${found.name}`); $('student-name').value=found.name;return true;
    }catch(error){if(version===lookupVersion)setText('roster-name',error.message);return false;}
  }
  $('student-id').addEventListener('input',()=>{
    clearTimeout(lookupTimer);++lookupVersion;$('student-name').value='';setText('roster-name','等待完整学号');
    if(/^[A-Za-z0-9_-]{3,32}$/.test($('student-id').value.trim()))lookupTimer=setTimeout(lookupName,350);
  });
  $('switch-identity').addEventListener('click',()=>{
    identitySwitch=true;$('student-id').value='';$('student-name').value='';$('confirm-switch').checked=false;
    $('identity-confirm').hidden=false;$('cancel-switch').hidden=false;
    setText('switch-message',`当前身份：${state.me.name}（${state.me.student_id}）。切换将记录原身份、新身份及时间。`);
    setText('roster-name','等待输入学号');setText('join-submit','确认切换并进入');setText('join-error','');
    renderStudent();$('student-id').focus();
  });
  $('cancel-switch').addEventListener('click',()=>{identitySwitch=false;renderStudent();});
  $('join-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(actionPending||guardBlocked)return;
    if(identitySwitch&&!$('confirm-switch').checked){setText('join-error','请确认使用本人身份后继续。');return;}
    const button=event.target.querySelector('button');button.disabled=true;actionPending=true;setText('join-error','');
    try {
      clearTimeout(lookupTimer);
      if(rosterEnabled&&!await lookupName())return;
      await api('/api/join',{name:$('student-name').value,student_id:$('student-id').value});
      identitySwitch=false;seenRound=null;selectedChoice=null;
      $('identity-confirm').hidden=true;$('cancel-switch').hidden=true;setText('join-submit','进入课堂');
      await refresh();
    }
    catch(error){setText('join-error',error.message);}
    finally{button.disabled=guardBlocked;actionPending=false;}
  });
  $('student-options').addEventListener('click',event=>{
    const button=event.target.closest('[data-choice]');
    if(button&&!button.disabled){
      if(!event.isTrusted){untrustedAction=true;showGuard('检测到脚本直接触发操作，请手动作答。',true);api('/api/client',{event:'untrusted_action'}).catch(()=>{});return;}
      selectedChoice=Number(button.dataset.choice);renderStudent();
    }
  });
  $('submit-vote').addEventListener('click',()=>{
    if(state?.round&&selectedChoice!==null)action('/api/vote',{round_id:state.round.id,choice:selectedChoice},'答案已提交。');
  });
  document.addEventListener('copy',event=>{
    if(!state?.me||state.round?.status!=='open')return;
    event.preventDefault();showGuard('本轮请独立思考后作答，课堂答题期间不提供复制题目。');api('/api/client',{event:'copy_blocked'}).catch(()=>{});
  });
  $('student-question-panel').addEventListener('contextmenu',event=>{
    if(state?.round?.status!=='open')return;
    event.preventDefault();showGuard('本轮请独立作答，讨论将在公布答案后进行。');api('/api/client',{event:'context_menu_blocked'}).catch(()=>{});
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&state?.me&&state.round?.status==='open')api('/api/client',{event:'focus_left'}).catch(()=>{});
  });
}

async function initEmbedded() {
  const params = new URLSearchParams(location.search);
  pointTarget = {chapter:params.get('chapter'),page:Number(params.get('page')),question_id:params.get('question'),seconds:60};
  const close = () => window.parent.postMessage({type:'classroom:close'}, '*');
  $('return-slide').addEventListener('click', close);
  $('close-round').addEventListener('click',()=>roundAction('close'));
  $('toggle-live').addEventListener('click',()=>roundAction('live'));
  $('reveal').addEventListener('click',toggleAnswer);
  $('repeat').addEventListener('click',()=>roundAction('repeat'));
  async function openPoint(replace = false) {
    pointError = '';
    try { await api('/api/open-point',{...pointTarget,replace}); }
    catch(error) { pointError = error.message; }
    await refresh();
  }
  $('switch-point').addEventListener('click',()=>openPoint(true));
  $('retry-point').addEventListener('click',()=>openPoint());
  $('show-access').addEventListener('click',()=>{ $('access-panel').hidden=!$('access-panel').hidden;$('activity-panel').hidden=true; });
  async function loadActivity() {
    const data=await api('/api/activity');
    const kinds={identity_switch:'切换身份',new_browser_login:'新浏览器登录',join:'首次加入',automation_block:'拦截自动化',focus_left:'切出页面',copy_blocked:'复制提醒',context_menu_blocked:'右键提醒'};
    $('activity-list').innerHTML=data.events.length?data.events.map(row=>`<tr><td>${e(new Date(row.happened*1000).toLocaleTimeString('zh-CN'))}</td><td>${e(kinds[row.kind]||row.kind)}</td><td>${e(row.old_id?`${row.old_id} → ${row.student_id}`:row.student_id||'未登记')}</td><td>${e(row.browser_id.slice(0,8))}<br>${e(row.ip)}<br><small title="${e(row.user_agent+' '+row.features)}">特征 ${e(row.fingerprint.slice(0,8))}</small></td><td>${e(row.detail)}</td></tr>`).join(''):'<tr><td colspan="5">暂无记录</td></tr>';
  }
  $('show-activity').addEventListener('click',async()=>{
    $('activity-panel').hidden=!$('activity-panel').hidden;$('access-panel').hidden=true;
    if(!$('activity-panel').hidden)try{await loadActivity();}catch(error){toast(error.message);}
  });
  $('refresh-activity').addEventListener('click',()=>loadActivity().catch(error=>toast(error.message)));
  document.querySelectorAll('[data-close-tool]').forEach(button=>button.addEventListener('click',()=>button.closest('.embedded-tool').hidden=true));
  const starsOnly=params.get('mode')==='stars';
  const stars=window.ClassroomStars.init({request:api,closeParent:close,refresh,starsOnly});
  window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.type==='classroom:stars-open')stars.show();});
  window.addEventListener('keydown',event=>{
    if (event.key==='Escape' || (event.altKey && event.key.toLowerCase()==='q')) {
      event.preventDefault();const tool=document.querySelector('.embedded-tool:not([hidden])');if(tool?.id==='stars-panel')stars.close();else if(tool)tool.hidden=true;else close();
    }
  });
  window.parent.postMessage({type:'classroom:ready'}, '*');
  if(starsOnly)await stars.show();else await openPoint();
}

async function boot() {
  try {
    if(view!=='student' && window.ClassroomRounds) {
      roundReview=window.ClassroomRounds.init({request:api,chart:$(view==='teacher'?'chart':'projector-chart'),anchor:$(view==='teacher'?'current-question':'projector-title')});
    }
    if(view==='teacher')await initTeacher();
    if(view==='student'){
      const config=await api('/api/config');rosterEnabled=config.roster_enabled;
      $('manual-name-label').hidden=rosterEnabled;$('student-name').required=!rosterEnabled;
      $('roster-name').hidden=!rosterEnabled;initStudent();
      try{await api('/api/client',{});}catch(error){if(!guardBlocked)toast(error.message);}
    }
    if(isDisplay){
      const config=await api('/api/config');setText('student-url',config.student_url);
      if(view==='embedded'&&['127.0.0.1','localhost','[::1]'].includes(new URL(config.student_url).hostname)){
        document.querySelector('.embedded-head .eyebrow').textContent='仅本机试用 · 学生手机无法接入';
        $('show-access').hidden=true;
      }
    }
    if(view==='embedded')await initEmbedded();
    await refresh();
    setInterval(refresh,1000); setInterval(tick,250);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  } catch(error){connection(false);toast(error.message);}
}
boot();
