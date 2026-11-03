const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
const elements={};
const element=id=>elements[id]||(elements[id]={});
const context=vm.createContext({document:{body:{dataset:{view:'teacher'}},getElementById:element},setText:(id,text)=>element(id).textContent=text});
vm.runInContext(source.slice(0,source.indexOf('function codeBlock')),context);
for(const round of [1,2,3,4,5])for(const status of ['open','closed','revealed']){
  vm.runInContext(`renderRoundControls({round_number:${round},status:'${status}'})`,context);
  const active=status==='open';
  assert.equal(element('close-round').hidden,!active);assert.equal(element('close-round').disabled,!active);
  assert.equal(element('repeat').hidden,active);assert.equal(element('repeat').disabled,active);
  assert.equal(element('close-round').textContent,`结束第${round}轮`);
  assert.equal(element('repeat').textContent,`再答一轮 · 第${round+1}轮`);
}
vm.runInContext('renderRoundControls(null)',context);
assert.equal(element('close-round').hidden,true);assert.equal(element('repeat').hidden,true);
assert(!source.includes('二次投票'));
console.log('Round 1–5 teacher controls, visible action and terminology passed.');
