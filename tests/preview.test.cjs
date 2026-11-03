const {test}=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,writeFile,mkdir,symlink,rm}=require('node:fs/promises');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const {startPreview,readCourse}=require('../player/preview.cjs');
test('preview confines files, rejects host substitution, and closes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'html-preview-'));let preview;
 try {
  await writeFile(join(root,'course.json'),JSON.stringify({schemaVersion:1,id:'demo',title:'Demo',content:{format:'slides-js',src:'slides.js'},plugins:{classroom:{questions:'assets/questions.json'}}}));
  await writeFile(join(root,'slides.js'),'const slides=[];');await writeFile(join(root,'secret.txt'),'private');
  await mkdir(join(root,'assets'));await writeFile(join(root,'assets','image.svg'),'<svg/>');
  await writeFile(join(root,'assets','questions.json'),'[]');
  preview=await startPreview({courseDir:root,frameOrigins:['http://127.0.0.1:4100']});
  assert.equal((await fetch(preview.url)).status,200);
  assert.equal((await fetch(new URL('slides.js',preview.url))).status,200);
  assert.equal((await fetch(new URL('secret.txt',preview.url))).status,404);
  assert.equal((await fetch(new URL('course.json',preview.url))).status,404);
  assert.equal((await fetch(new URL('assets/image.svg',preview.url))).status,200);
  assert.equal((await fetch(new URL('assets/questions.json',preview.url))).status,404);
  assert.equal((await fetch(preview.url,{method:'POST'})).status,405);
  const hostileStatus=await new Promise((resolve,reject)=>{
   require('node:http').get(preview.url,{headers:{host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode)}).on('error',reject);
  });
  assert.equal(hostileStatus,403);
  await preview.stop();await preview.stop();await assert.rejects(fetch(preview.url));
 }finally{await preview?.stop();await rm(root,{recursive:true,force:true})}
});
test('manifest rejects unsupported versions and traversal before opening a listener',async()=>{
 const root=await mkdtemp(join(tmpdir(),'html-manifest-'));
 try {
  for(const content of [{schemaVersion:2,id:'demo',title:'Demo',content:{format:'slides-js',src:'slides.js'}},{schemaVersion:1,id:'demo',title:'Demo',content:{format:'slides-js',src:'../outside.js'}}]){
   await writeFile(join(root,'course.json'),JSON.stringify(content));await assert.rejects(readCourse(root));
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
test('asset directory junction cannot expose files outside the course',async()=>{
 const root=await mkdtemp(join(tmpdir(),'html-link-'));let preview;
 try{
  const course=join(root,'course'),outside=join(root,'private');await mkdir(course);await mkdir(outside);
  await writeFile(join(outside,'secret.txt'),'private');await symlink(outside,join(course,'assets'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(course,'slides.js'),'const slides=[]');await writeFile(join(course,'course.json'),JSON.stringify({schemaVersion:1,id:'demo',title:'Demo',content:{format:'slides-js',src:'slides.js'}}));
  preview=await startPreview({courseDir:course});assert.equal((await fetch(new URL('assets/secret.txt',preview.url))).status,404);
 }finally{await preview?.stop();await rm(root,{recursive:true,force:true})}
});
