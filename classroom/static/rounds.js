/* Local view state only: reviewing results never changes the active question. */
window.ClassroomRounds = {
  init({request, chart, anchor}) {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const label = r => `第${r.round_number}轮`;
    const percent = (n,total) => total ? Math.round(n / total * 100) : 0;
    const block = document.createElement('section');
    block.className = 'round-review';
    block.innerHTML = `<button type="button" class="button secondary" id="show-rounds" aria-expanded="false" disabled>轮次与对比</button><div id="round-review-controls" hidden><div class="round-review-selectors"><label>查看轮次<select id="review-round" disabled><option value="live">当前轮（实时）</option></select></label><label>对比轮次<select id="compare-round" disabled><option value="">不对比</option></select></label><button type="button" class="button secondary" id="return-live">返回实时</button></div><p id="round-review-note" class="subtle" role="status"></p></div>`;
    anchor.before(block);
    const result = document.createElement('div');
    result.className = 'round-review-results'; result.hidden = true;
    chart.after(result);
    const $ = id => block.querySelector('#'+id);
    let current = null, data = null, selected = 'live', compared = '', expanded = false;
    let pending = false, lastFetch = 0, version = 0, renderKey = '', optionKey = '';

    function reset() { selected='live'; compared=''; renderKey=''; }
    function selectOptions() {
      const rounds = data?.rounds || [];
      const selectedId = selected === 'live' ? current?.id : Number(selected);
      if (!rounds.some(r => r.id === selectedId)) selected = 'live';
      if (Number(compared) === (selected==='live'?current?.id:Number(selected)) || !rounds.some(r=>r.id===Number(compared))) compared='';
      const key = JSON.stringify([rounds,selected,compared,current?.id]);
      if(key===optionKey)return;
      optionKey=key;
      const option = r => `<option value="${r.id}">${label(r)} · ${r.submitted}人 · ${r.status==='open'?'进行中':'已结束'}</option>`;
      $('review-round').innerHTML = '<option value="live">当前轮（实时）</option>'+rounds.map(option).join('');
      $('compare-round').innerHTML = '<option value="">不对比</option>'+rounds.filter(r=>r.id!==(selected==='live'?current?.id:Number(selected))).map(option).join('');
      $('review-round').value=selected; $('compare-round').value=compared;
      $('review-round').disabled=!rounds.length; $('compare-round').disabled=rounds.length<2;
    }
    function render() {
      const reviewing = expanded && (selected!=='live' || compared!=='');
      document.body.classList.toggle('round-reviewing',reviewing);
      chart.hidden=reviewing; result.hidden=!reviewing;
      if(!reviewing) {
        setNote(data ? `共${data.rounds.length}轮 · 当前显示第${current?.round_number || 1}轮实时结果` : '正在读取轮次…');
        return;
      }
      const first=data?.rounds.find(r=>r.id===(selected==='live'?current?.id:Number(selected)));
      const second=data?.rounds.find(r=>r.id===Number(compared));
      if(!first){setNote('正在读取轮次…');return;}
      const rounds=second?[first,second]:[first];
      const key=JSON.stringify([rounds,current?.question]);
      if(renderKey!==key) {
        renderKey=key;
        const summary=r=>`<div class="round-stat"><strong>${label(r)}</strong><span>${r.submitted}人作答</span><span>${r.correct_count===null?'正确率：'+(current.question.kind==='poll'?'不适用':'公布答案后显示'):r.correct_rate===null?'暂无作答':`正确率 ${percent(r.correct_count,r.submitted)}% · ${r.correct_count}人答对`}</span></div>`;
        const bars=current.question.options.map((option,index)=>`<div class="round-compare-option"><div class="round-option-label"><b>${'ABCDEF'[index]}</b> ${escape(option)}</div>${rounds.map((r,i)=>r.counts===null?`<p class="subtle">${label(r)}：分布已隐藏</p>`:`<div class="round-compare-bar"><span>${label(r)}</span><div class="bar-track"><div class="bar-fill round-color-${i}" style="width:${percent(r.counts[index],r.submitted)}%"></div></div><strong>${r.counts[index]}人 · ${percent(r.counts[index],r.submitted)}%</strong></div>`).join('')}</div>`).join('');
        let delta='';
        if(second && first.correct_rate!==null && second.correct_rate!==null) {
          const change=Math.round((second.correct_rate-first.correct_rate)*1000)/10;
          delta=`<p class="round-delta">${label(second)}相较${label(first)}，正确率${change>0?'提高':change<0?'降低':'持平'}${change ? ` ${Math.abs(change)} 个百分点` : ''}</p>`;
        }
        result.innerHTML=`<div class="round-stat-grid">${rounds.map(summary).join('')}</div>${delta}<div class="round-comparison-chart">${bars}</div>`;
      }
      setNote(`${rounds.map(label).join(' 对比 ')} · 当前${label(current)}${current.status==='open'?'仍在作答':'已结束'}`);
    }
    function setNote(text){$('round-review-note').textContent=text;}
    async function load(force=false) {
      if(!current || !expanded || pending || (!force && Date.now()-lastFetch<1500))return;
      pending=true; const generation=version, id=current.id;
      try {
        const next=await request('/api/rounds?round_id='+id);
        if(generation!==version || current?.id!==id)return;
        data=next; lastFetch=Date.now(); selectOptions(); render();
      } catch(error) {if(generation===version){setNote(error.message);lastFetch=Date.now();}}
      finally {pending=false;}
    }
    $('show-rounds').addEventListener('click',()=>{
      expanded=!expanded; $('round-review-controls').hidden=!expanded;
      block.classList.toggle('expanded',expanded);
      $('show-rounds').setAttribute('aria-expanded',String(expanded));
      if(expanded){setNote('正在读取轮次…');load(true);}else{reset();render();}
    });
    $('review-round').addEventListener('change',()=>{selected=$('review-round').value;selectOptions();render();});
    $('compare-round').addEventListener('change',()=>{compared=$('compare-round').value;render();});
    $('return-live').addEventListener('click',()=>{reset();selectOptions();render();load(true);});
    return {
      update(round) {
        const changed=current?.question.id!==round?.question.id || (current && !current.question.id && current.id!==round?.id && !round?.previous_id);
        if(changed || !round){version++;data=null;lastFetch=0;optionKey='';reset();result.replaceChildren();}
        current=round; block.hidden=!round; $('show-rounds').disabled=!round;
        if(changed || !round)selectOptions();
        if(!round){chart.hidden=false;result.hidden=true;document.body.classList.remove('round-reviewing');return;}
        if(data && !data.rounds.some(r=>r.id===round.id)){lastFetch=0;}
        if(expanded){render();load();}
      }
    };
  }
};
