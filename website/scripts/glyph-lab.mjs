// Glyph Lab — live workbench for tuning glyphcss illustrations. Renders
// server-side with the SAME core the baker uses (glyph-render.mjs), so the
// preview is byte-identical to the bake. All knobs are sliders; the scene is
// shown inside its full cols×rows frame (the dashed box = the scene bounds) so
// you can see how the model fills it. Drag to orbit, wheel to zoom.
//   Run from website/:  node scripts/glyph-lab.mjs   → open the printed URL.
import { createServer } from 'node:http';
import { loadPolys, applyOrient, normalize, render } from './glyph-render.mjs';

const PORT = 7654;
const cache = new Map();
function polysFor(modelPath, orient) {
  const key = modelPath + '|' + orient;
  if (!cache.has(key)) cache.set(key, normalize(applyOrient(loadPolys(modelPath), orient)));
  return cache.get(key);
}

const PRESETS = [
  ['key ★', '/tmp/models/key-ipoly.glb'],
  ['sputnik', '/tmp/models/sputnik.glb'],
  ['missile', '/tmp/models/missile.glb'],
  ['satellite', '/tmp/models/satellite-g1.glb'],
  ['hubble', '/tmp/models/hubble.glb'],
  ['anchor', '/tmp/models/anchor-g.glb'],
  ['oil pump', '/tmp/models/oilpump.glb'],
  ['ship', '/tmp/models/ship.glb'],
  ['coliseum', '/Users/apresmoi/glyphcss/website/public/gallery/obj/coliseum.obj'],
];

// slider defs: id,label,min,max,step,default — defaults tuned to the detail-rich
// look we settled on (high-res grid, ~35 zoom, low ambient, 6-level ramp).
const SLIDERS = [
  ['orient', 'orient (0 native·1 Zup·2 standX·3 alt·4 lay)', 0, 4, 1, 0],
  ['rotX', 'rotX  pitch', -90, 90, 1, 57],
  ['rotY', 'rotY  yaw', -180, 180, 1, 23],
  ['zoom', 'zoom', 2, 80, 0.5, 35.5],
  ['offsetX', 'offset X (re-center)', -1.5, 1.5, 0.02, 0],
  ['offsetY', 'offset Y (re-center)', -1.5, 1.5, 0.02, 0],
  ['az', 'light azimuth', -180, 180, 1, 40],
  ['el', 'light elevation', -90, 90, 1, 35],
  ['intensity', 'light intensity', 0, 2, 0.05, 1],
  ['ambient', 'ambient', 0, 1, 0.05, 0.1],
  ['cols', 'grid cols', 30, 220, 1, 158],
  ['rows', 'grid rows', 16, 140, 1, 94],
  ['cellAspect', 'cellAspect (sampling)', 0.8, 2.2, 0.01, 1.48],
  ['lineHeight', 'lineHeight (display)', 0.5, 1.6, 0.01, 1.04],
  ['levels', 'ramp chars (2–10 levels)', 2, 10, 1, 6],
];

const HTML = `<!doctype html><meta charset=utf8><title>Glyph Lab</title>
<style>
 body{margin:0;font:13px/1.4 system-ui,sans-serif;background:#14110e;color:#e8e0cf;display:flex;height:100vh}
 #panel{width:320px;padding:14px 16px;overflow:auto;border-right:1px solid #3a342b;flex:0 0 auto}
 #stage{flex:1;display:flex;align-items:center;justify-content:center;background:#0d0b08}
 #box{border:1px dashed #6b5d44;background:#100d09;padding:0}
 pre#out{font-family:ui-monospace,'JetBrains Mono',monospace;color:#f4eee0;white-space:pre;margin:0;letter-spacing:0}
 .s{margin:7px 0}.s label{font-size:11px;color:#b9b0a0;display:flex;justify-content:space-between}
 .s input{width:100%}
 input[type=text]{width:100%;background:#241f18;color:#e8e0cf;border:1px solid #3a342b;border-radius:3px;padding:4px;box-sizing:border-box}
 button{background:#3a342b;color:#f4eee0;border:0;border-radius:4px;padding:6px 9px;margin:2px 3px 2px 0;cursor:pointer;font-size:12px}
 button:hover{background:#4a4234}.amber{background:#b8732a}.amber:hover{background:#c8843a}
 .preset{font-size:11px;padding:4px 7px}.tog.on{background:#b8732a}
 .hint{color:#8a8270;font-size:11px;margin:6px 0}
 #cfg{width:100%;height:110px;background:#241f18;color:#9fd9a0;border:1px solid #3a342b;font-family:monospace;font-size:10px;margin-top:6px;box-sizing:border-box}
</style>
<div id=panel>
 <input type=text id=modelPath placeholder="/abs/path/to/model.glb|obj|vox">
 <div style=margin:6px:0>${PRESETS.map(([l, p]) => `<button class=preset data-path="${p}">${l}</button>`).join('')}</div>
 ${SLIDERS.map(([id, label, min, max, step, def]) => `<div class=s><label>${label}<span id=${id}v>${def}</span></label><input type=range id=${id} min=${min} max=${max} step=${step} value=${def}></div>`).join('')}
 <div style=margin-top:8px>
  <button class="tog on" id=doubleSided>doubleSided</button>
  <button class="tog on" id=smoothShading>smoothShading</button>
 </div>
 <div style=margin-top:8px>
  <button id=autoframe>Auto-frame ↦ zoom</button>
  <button class=amber id=copy>Copy config</button>
 </div>
 <div class=hint id=status>pick a preset · drag art to orbit · wheel to zoom</div>
 <textarea id=cfg readonly></textarea>
</div>
<div id=stage><div id=box><pre id=out>load a model…</pre></div></div>
<script>
const $=id=>document.getElementById(id);
const SL=${JSON.stringify(SLIDERS.map((s) => s[0]))};
const togs={doubleSided:true,smoothShading:true};
function cfg(){const c={modelPath:$('modelPath').value,autoFrame:false,...togs};for(const id of SL)c[id]=+$(id).value;return c;}
function labels(){for(const id of SL)$(id+'v').textContent=$(id).value;}
let t=null,busy=false;
async function draw(autoFrame){
 labels();const c=cfg();if(!c.modelPath)return;
 if(autoFrame)c.autoFrame=true;
 $('cfg').value=JSON.stringify(cfg(),null,0);
 if(busy){clearTimeout(t);t=setTimeout(()=>draw(autoFrame),60);return;}
 busy=true;
 try{
  const r=await fetch('/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(c)});
  const j=await r.json();busy=false;
  if(j.error){$('status').textContent='ERR: '+j.error;return;}
  const pre=$('out');pre.textContent=j.full;
  const lh=+$('lineHeight').value;pre.style.lineHeight=lh;
  // size the box so the whole grid fits the stage; char cell ~0.6em wide
  const stage=$('stage');const fw=(stage.clientWidth-60)/(j.cols*0.62);const fh=(stage.clientHeight-60)/(j.rows*lh);
  pre.style.fontSize=Math.max(3,Math.min(fw,fh,18)).toFixed(2)+'px';
  if(autoFrame)$('zoom').value=j.zoom.toFixed(1);
  $('status').textContent='grid '+j.cols+'×'+j.rows+' · art '+j.w+'×'+j.h+' · zoom '+j.zoom.toFixed(1);
 }catch(e){busy=false;$('status').textContent='ERR '+e.message;}
}
function schedule(){clearTimeout(t);t=setTimeout(()=>draw(false),70);}
SL.forEach(id=>$(id).addEventListener('input',schedule));
document.querySelectorAll('.preset').forEach(b=>b.onclick=()=>{$('modelPath').value=b.dataset.path;draw(true);});
$('modelPath').addEventListener('change',()=>draw(true));
['doubleSided','smoothShading'].forEach(k=>$(k).onclick=()=>{togs[k]=!togs[k];$(k).classList.toggle('on',togs[k]);schedule();});
$('autoframe').onclick=()=>draw(true);
$('copy').onclick=()=>{navigator.clipboard.writeText($('cfg').value);$('status').textContent='config copied — paste it to the desk';};
// orbit + wheel
let drag=null;
$('out').addEventListener('mousedown',e=>{drag={x:e.clientX,y:e.clientY,rx:+$('rotX').value,ry:+$('rotY').value};e.preventDefault();});
window.addEventListener('mouseup',()=>drag=null);
window.addEventListener('mousemove',e=>{if(!drag)return;$('rotY').value=Math.max(-180,Math.min(180,drag.ry+(e.clientX-drag.x)*0.5));$('rotX').value=Math.max(-90,Math.min(90,drag.rx-(e.clientY-drag.y)*0.5));schedule();});
$('stage').addEventListener('wheel',e=>{e.preventDefault();const z=$('zoom');z.value=Math.max(2,Math.min(60,+z.value-Math.sign(e.deltaY)*1));schedule();},{passive:false});
labels();
</script>`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(HTML);
  }
  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        const r = render(polysFor(cfg.modelPath, cfg.orient ?? 0), cfg);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
server.listen(PORT, () => console.log(`Glyph Lab → http://localhost:${PORT}`));
