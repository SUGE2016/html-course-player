const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
function element() {
  const classes = new Set();
  return {hidden:false,disabled:false,value:'',innerHTML:'',textContent:'',listeners:{},
    classList:{toggle(c,on){on?classes.add(c):classes.delete(c);},remove(c){classes.delete(c);}},
    querySelector(selector){return elements.get(selector.slice(1));},
    addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(){},
    replaceChildren(){this.innerHTML='';},before(node){this.inserted=node;},after(node){this.inserted=node;}};
}
for(const id of ['show-rounds','round-review-controls','review-round','compare-round','return-live','round-review-note']) elements.set(id,element());
const context={window:{},document:{body:element(),createElement:element},Date};
vm.runInNewContext(fs.readFileSync(__dirname+'/static/rounds.js','utf8'),context);
const chart=element(),anchor=element();
const rows=[1,2,3,4].map(n=>({id:n,round_number:n,status:'revealed',submitted:1,counts:n===3?[0,0,1,0]:[0,1,0,0],correct_count:n===3?0:1,correct_rate:n===3?0:1}));
let calls=0;
const controller=context.window.ClassroomRounds.init({chart,anchor,request:async()=>{calls++;return {root_id:1,rounds:rows};}});
const current={id:4,round_number:4,status:'closed',question:{id:'q1',kind:'choice',options:['一','二','三','四']}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const fire=(id,name)=>elements.get(id).listeners[name]();
(async()=>{
  controller.update(null);assert(anchor.inserted.hidden);assert(!chart.hidden);
  controller.update(current);assert(!anchor.inserted.hidden);assert.equal(calls,0);
  fire('show-rounds','click');await flush();assert.equal(calls,1);
  assert(elements.get('review-round').innerHTML.includes('第4轮'));
  elements.get('review-round').value='3';fire('review-round','change');
  assert(chart.hidden);assert(chart.inserted.innerHTML.includes('正确率 0%'));
  elements.get('compare-round').value='4';fire('compare-round','change');
  assert(chart.inserted.innerHTML.includes('提高 100 个百分点'));
  assert.equal(current.id,4);
  fire('return-live','click');await flush();assert(!chart.hidden);assert(chart.inserted.hidden);
  assert.equal(elements.get('review-round').value,'live');
  elements.get('review-round').value='3';fire('review-round','change');
  fire('show-rounds','click');assert(!chart.hidden);assert(chart.inserted.hidden);
  controller.update({...current,id:9,question:{...current.question,id:'q2'}});
  assert(elements.get('review-round').disabled);assert.equal(chart.inserted.innerHTML,'');
  controller.update(null);assert(anchor.inserted.hidden);assert(!chart.hidden);
  console.log('Round review: selection, comparison, live return, collapse and question reset passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
