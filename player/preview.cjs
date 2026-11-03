/* Managed preview. Importing this module opens no ports or files. */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.mp3':'audio/mpeg','.woff2':'font/woff2'};
const inside=(root,file)=>file.startsWith(root+path.sep);
const safePath=value=>typeof value==='string' && value.length>0 && !/[\\?#\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').some(p=>!p||p.startsWith('.')||p.includes(':'));
const js=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const attr=value=>value.replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));

async function readCourse(courseDir) {
  const root=await fs.realpath(courseDir);
  const manifestPath=await fs.realpath(path.join(root,'course.json'));
  if(!inside(root,manifestPath))throw new Error('课程清单越出课程目录');
  const stat=await fs.stat(manifestPath);
  if(stat.size>65536)throw new Error('课程清单过大');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  if(manifest.schemaVersion!==1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(manifest.id||'') || typeof manifest.title!=='string' || manifest.title.length>200)throw new Error('无效的课程清单');
  if(manifest.content?.format!=='slides-js')throw new Error('不支持的课件格式');
  for(const key of ['styles','scripts'])if(manifest[key]!==undefined && (!Array.isArray(manifest[key])||manifest[key].length>20))throw new Error('无效的课程资源列表');
  const files=[manifest.content.src,...(manifest.styles||[]),...(manifest.scripts||[])];
  if(manifest.plugins?.classroom?.questions)files.push(manifest.plugins.classroom.questions);
  for(const file of files) {
    if(!safePath(file))throw new Error('无效的课程资源路径');
    const real=await fs.realpath(path.join(root,file));
    if(!inside(root,real)||!(await fs.stat(real)).isFile())throw new Error('课程资源越出目录或不可读取');
  }
  return {root,manifest};
}

async function startPreview({courseDir,port=0,frameOrigins=[]}) {
  const {root,manifest}=await readCourse(courseDir), player=await fs.realpath(__dirname);
  const origins=frameOrigins.map(value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.origin!==value)throw new Error('无效的宿主来源');return value;});
  const token=randomBytes(24).toString('hex'),prefix='/'+token+'/';
  let runtime={},url;
  const publicFiles=new Set([manifest.content.src,...(manifest.styles||[]),...(manifest.scripts||[])]);
  const privateFiles=new Set(await Promise.all(['course.json',...(manifest.plugins?.classroom?.questions?[manifest.plugins.classroom.questions]:[])].map(file=>fs.realpath(path.join(root,file)))));
  function html(){
    const config={title:manifest.title,chapter:manifest.id,groups:manifest.groups,plugins:{}};
    if(manifest.plugins?.classroom && runtime.classroomOrigin)config.plugins.classroom={...manifest.plugins.classroom,origin:runtime.classroomOrigin};
    const scripts=['player/vendor/reveal/reveal.js','player/vendor/reveal/highlight.js',manifest.content.src,'player/player.js',...(manifest.scripts||[])];
    if(manifest.plugins?.zoom)scripts.push('player/plugins/zoom-controls.js');
    if(config.plugins.classroom)scripts.push('player/plugins/classroom.js');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+
      ['player/vendor/reveal/reset.css','player/vendor/reveal/reveal.css','player/vendor/reveal/monokai.css','player/theme.css','player/controls.css',...(manifest.styles||[])].map(s=>`<link rel="stylesheet" href="${attr(s)}">`).join('')+
      '</head><body><div class="reveal"><div class="slides" id="slides"></div></div>'+`<script>window.COURSE_CONFIG=${js(config)}</script>`+scripts.map(s=>`<script src="${attr(s)}"></script>`).join('')+'</body></html>';
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.host!==new URL(url).host){res.writeHead(403).end();return;}
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
      const pathname=decodeURIComponent(new URL(req.url,url).pathname);
      if(!pathname.startsWith(prefix)){res.writeHead(404).end();return;}
      const name=pathname.slice(prefix.length);
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',`frame-ancestors ${origins.length?origins.join(' '):"'none'"}; object-src 'none'; base-uri 'none'`);
      if(!name||name==='index.html'){res.setHeader('Content-Type',mime['.html']);res.end(req.method==='HEAD'?undefined:html());return;}
      if(!safePath(name)){res.writeHead(404).end();return;}
      const shared=name.startsWith('player/'),base=shared?player:root,relative=shared?name.slice(7):name;
      if(shared?!/^(player\.js|theme\.css|controls\.css|plugins\/(zoom-controls|classroom)\.js|vendor\/reveal\/[A-Za-z0-9_.-]+)$/.test(relative):!publicFiles.has(name)&&!name.startsWith('assets/')){res.writeHead(404).end();return;}
      const real=await fs.realpath(path.join(base,relative));
      if(!inside(base,real)||privateFiles.has(real)){res.writeHead(404).end();return;}
      const stat=await fs.stat(real);if(!stat.isFile()||stat.size>128*1024*1024){res.writeHead(404).end();return;}
      res.setHeader('Content-Type',mime[path.extname(real)]||'application/octet-stream');
      res.end(req.method==='HEAD'?undefined:await fs.readFile(real));
    }catch{if(!res.headersSent)res.writeHead(404);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  url=`http://127.0.0.1:${server.address().port}${prefix}`;
  let stopped;
  return {url,origin:new URL(url).origin,manifest,root,setRuntime(value){
    if(value.classroomOrigin){const u=new URL(value.classroomOrigin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.origin!==value.classroomOrigin)throw new Error('无效的课堂地址');}
    runtime={classroomOrigin:value.classroomOrigin};
  },stop(){return stopped??=new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}};
}
module.exports={readCourse,startPreview};
