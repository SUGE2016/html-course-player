/* Serve one course and the shared player; no workspace directory listing. */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {pipeline}=require('node:stream');
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const course=path.resolve(value('--chapter','.')),player=__dirname,port=Number(value('--port','4173'));
if(!fs.existsSync(path.join(course,'index.html')))throw new Error('Course index.html not found: '+course);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
function resolveFile(url){
  let pathname;try{pathname=decodeURIComponent(new URL(url,'http://localhost').pathname);}catch{return null;}
  const shared=pathname.startsWith('/player/'),base=shared?player:course,relative=(shared?pathname.slice(8):pathname.slice(1))||'index.html';
  if(relative.split(/[\\/]/).some(part=>part.startsWith('.')))return null;
  const file=path.resolve(base,relative||'index.html');
  if(!file.startsWith(base+path.sep))return null;
  // The local preview never serves teacher data or arbitrary workspace files.
  if(!shared&&!['index.html','course.js','slides.js','styles.css','interactions.js'].includes(relative)&&!relative.startsWith('assets/'))return null;
  if(shared&&!/^(player\.js|theme\.css|controls\.css|plugins\/(zoom-controls|terminal|classroom)\.js|vendor\/reveal\/[^/]+)$/.test(relative))return null;
  return file;
}
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  const file=resolveFile(req.url);if(!file){res.writeHead(404);return res.end('Not found');}
  fs.stat(file,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD')return res.end();pipeline(fs.createReadStream(file),res,()=>{});
  });
});
if(require.main===module)server.listen(port,'127.0.0.1',()=>console.log(`Course preview: http://127.0.0.1:${port}/`));
module.exports={resolveFile,server};
