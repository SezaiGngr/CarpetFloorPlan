import { useState, useRef, useCallback, useEffect } from 'react'
import './FloorPlanAnalyzer.css'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_IMG_WIDTH = 900

const LABEL_PROMPT = `Read ALL dimension labels from this floor plan image.

For each label, estimate its position as a fraction of the image (0-1):

Return JSON:
{
  "dimensions": [
    { "text": "3.7 x 3.7M", "x_frac": 0.2, "y_frac": 0.15, "width_m": 3.7, "height_m": 3.7 },
    { "text": "5.5 x 3.7M", "x_frac": 0.6, "y_frac": 0.15, "width_m": 5.5, "height_m": 3.7 }
  ]
}

- x_frac: 0=left, 1=right. y_frac: 0=top, 1=bottom.
- For "3.8 x 3.9M": width_m=3.8, height_m=3.9 (first=width, second=height)
- Skip non-dimension labels (BATH, VOID, FP etc)

Return ONLY valid JSON.`


function detectWalls(imageData, width, height) {
  var data = imageData.data
  var DARK = 105, MIN_LEN = 15, MIN_THICK = 4, MAX_GAP = 6

  var mask = new Uint8Array(width * height)
  for (var i = 0; i < width * height; i++) {
    var r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3]
    if (a > 100 && r < DARK && g < DARK && b < DARK) mask[i] = 1
  }

  var hSegs = [], lastHY = -999
  for (var y = 0; y < height; y++) {
    if (y - lastHY < 7) continue
    var rs = -1, gap = 0, found = false
    for (var x = 0; x < width; x++) {
      var t = 0
      for (var dy = -5; dy <= 5; dy++) { var ny=y+dy; if(ny>=0&&ny<height&&mask[ny*width+x])t++ }
      if (t >= MIN_THICK) { if(rs===-1)rs=x; gap=0 }
      else if (rs!==-1) { gap++; if(gap>MAX_GAP){var e=x-gap;if(e-rs>=MIN_LEN){hSegs.push({x1:rs,y1:y,x2:e,y2:y});found=true}rs=-1;gap=0} }
    }
    if(rs!==-1){var ex=width-1-gap;if(ex-rs>=MIN_LEN){hSegs.push({x1:rs,y1:y,x2:ex,y2:y});found=true}}
    if(found)lastHY=y
  }

  var vSegs = [], lastVX = -999
  for (var x2 = 0; x2 < width; x2++) {
    if (x2 - lastVX < 7) continue
    var rs2=-1,gap2=0,found2=false
    for (var y2 = 0; y2 < height; y2++) {
      var t2 = 0
      for (var dx=-5;dx<=5;dx++){var nx=x2+dx;if(nx>=0&&nx<width&&mask[y2*width+nx])t2++}
      if(t2>=MIN_THICK){if(rs2===-1)rs2=y2;gap2=0}
      else if(rs2!==-1){gap2++;if(gap2>MAX_GAP){var e2=y2-gap2;if(e2-rs2>=MIN_LEN){vSegs.push({x1:x2,y1:rs2,x2:x2,y2:e2});found2=true}rs2=-1;gap2=0}}
    }
    if(rs2!==-1){var ey=height-1-gap2;if(ey-rs2>=MIN_LEN){vSegs.push({x1:x2,y1:rs2,x2:x2,y2:ey});found2=true}}
    if(found2)lastVX=x2
  }

  var mH = mergeSegments(hSegs,'h',10), mV = mergeSegments(vSegs,'v',10)

  // Envelope filter
  var env = findEnvelope(mH, mV)
  if (env) {
    mH = mH.filter(function(w){return w.y1>=env.top-10&&w.y1<=env.bottom+10})
    mV = mV.filter(function(w){return w.x1>=env.left-10&&w.x1<=env.right+10})
  }

  // ONE end must connect — this is what worked best
  mH = filterOneEnd(mH, mV, 'h', 25)
  mV = filterOneEnd(mV, mH, 'v', 25)

  return { horizontal: mH, vertical: mV }
}

// Keep wall if at least ONE end connects to a perpendicular wall
function filterOneEnd(walls, cross, axis, tol) {
  return walls.filter(function(w) {
    var connected = false
    cross.forEach(function(cw) {
      if (connected) return
      if (axis === 'h') {
        if (w.y1 >= cw.y1-tol && w.y1 <= cw.y2+tol) {
          if (Math.abs(cw.x1-w.x1)<tol || Math.abs(cw.x1-w.x2)<tol) connected = true
        }
      } else {
        if (w.x1 >= cw.x1-tol && w.x1 <= cw.x2+tol) {
          if (Math.abs(cw.y1-w.y1)<tol || Math.abs(cw.y1-w.y2)<tol) connected = true
        }
      }
    })
    return connected
  })
}

function findEnvelope(h,v) {
  if(h.length<2||v.length<2)return null
  var hs=h.slice().sort(function(a,b){return a.y1-b.y1})
  var vs=v.slice().sort(function(a,b){return a.x1-b.x1})
  return{top:hs[0].y1,bottom:hs[hs.length-1].y1,left:vs[0].x1,right:vs[vs.length-1].x1}
}

function mergeSegments(segs,axis,tol) {
  if(!segs.length)return[]
  var s=segs.slice().sort(function(a,b){return axis==='h'?a.y1-b.y1||a.x1-b.x1:a.x1-b.x1||a.y1-b.y1})
  var m=[],c={x1:s[0].x1,y1:s[0].y1,x2:s[0].x2,y2:s[0].y2}
  for(var i=1;i<s.length;i++){
    var si=s[i]
    var sp=axis==='h'?Math.abs(si.y1-c.y1)<=tol:Math.abs(si.x1-c.x1)<=tol
    var ov=axis==='h'?si.x1<=c.x2+tol*2:si.y1<=c.y2+tol*2
    if(sp&&ov){
      if(axis==='h'){c.x1=Math.min(c.x1,si.x1);c.x2=Math.max(c.x2,si.x2);c.y1=Math.round((c.y1+si.y1)/2);c.y2=c.y1}
      else{c.y1=Math.min(c.y1,si.y1);c.y2=Math.max(c.y2,si.y2);c.x1=Math.round((c.x1+si.x1)/2);c.x2=c.x1}
    }else{m.push(c);c={x1:si.x1,y1:si.y1,x2:si.x2,y2:si.y2}}
  }
  m.push(c);return m
}


// ─── ROOM + PPM MATCHING ─────────────────────────────────────────────────────

function detectRooms(hW, vW, tol) {
  tol = tol || 20
  var yPos = [], xPos = []
  hW.forEach(function(w){ var f=false; for(var i=0;i<yPos.length;i++){if(Math.abs(yPos[i]-w.y1)<tol){f=true;break}} if(!f)yPos.push(w.y1) })
  vW.forEach(function(w){ var f=false; for(var i=0;i<xPos.length;i++){if(Math.abs(xPos[i]-w.x1)<tol){f=true;break}} if(!f)xPos.push(w.x1) })
  yPos.sort(function(a,b){return a-b}); xPos.sort(function(a,b){return a-b})

  var rooms = []
  for (var yi=0;yi<yPos.length-1;yi++) {
    for (var xi=0;xi<xPos.length-1;xi++) {
      var t=yPos[yi],b=yPos[yi+1],l=xPos[xi],r=xPos[xi+1]
      if(r-l<30||b-t<30)continue
      var sides=0
      if(hasH(hW,t,l,r,tol))sides++
      if(hasH(hW,b,l,r,tol))sides++
      if(hasV(vW,l,t,b,tol))sides++
      if(hasV(vW,r,t,b,tol))sides++
      if(sides>=3) rooms.push({left:l,top:t,right:r,bottom:b,widthPx:r-l,heightPx:b-t,cx:(l+r)/2,cy:(t+b)/2})
    }
  }
  return rooms
}

function hasH(ws,y,x1,x2,t){for(var i=0;i<ws.length;i++){var w=ws[i];if(Math.abs(w.y1-y)<t&&Math.min(w.x2,x2)-Math.max(w.x1,x1)>(x2-x1)*0.3)return true}return false}
function hasV(ws,x,y1,y2,t){for(var i=0;i<ws.length;i++){var w=ws[i];if(Math.abs(w.x1-x)<t&&Math.min(w.y2,y2)-Math.max(w.y1,y1)>(y2-y1)*0.3)return true}return false}

function matchPPM(rooms, dims, imgW, imgH) {
  var ppms = []
  ;(dims||[]).forEach(function(dim) {
    if(!dim.width_m||!dim.height_m||dim.x_frac==null)return
    var lx=dim.x_frac*imgW, ly=dim.y_frac*imgH
    var best=null,bd=Infinity
    rooms.forEach(function(r){
      if(lx>=r.left-30&&lx<=r.right+30&&ly>=r.top-30&&ly<=r.bottom+30){
        var d=Math.sqrt(Math.pow(lx-r.cx,2)+Math.pow(ly-r.cy,2))
        if(d<bd){bd=d;best=r}
      }
    })
    if(!best){rooms.forEach(function(r){var d=Math.sqrt(Math.pow(lx-r.cx,2)+Math.pow(ly-r.cy,2));if(d<bd){bd=d;best=r}})}
    if(best&&dim.width_m>0&&dim.height_m>0){
      var px=best.widthPx/dim.width_m, py=best.heightPx/dim.height_m
      if(px>10&&px<200)ppms.push(px)
      if(py>10&&py<200)ppms.push(py)
      best.matchedDim=dim; best.ppmX=px; best.ppmY=py
    }
  })
  if(!ppms.length)return null
  ppms.sort(function(a,b){return a-b})
  var med=ppms[Math.floor(ppms.length/2)]
  var filt=ppms.filter(function(v){return Math.abs(v-med)/med<0.2})
  if(!filt.length)filt=[med]
  var sum=0;filt.forEach(function(v){sum+=v});return sum/filt.length
}


// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function FloorPlanAnalyzer() {
  const [image,setImage]=useState(null)
  const [analysis,setAnalysis]=useState(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState(null)
  const canvasRef=useRef(null),fileRef=useRef(null),imgElRef=useRef(null)

  var handleFile=useCallback(function(file){
    if(!file||!file.type||!file.type.startsWith('image/'))return
    setError(null);setAnalysis(null)
    var reader=new FileReader()
    reader.onload=function(e){
      var img=new Image()
      img.onload=function(){
        var scale=img.width>MAX_IMG_WIDTH?MAX_IMG_WIDTH/img.width:1
        var c=document.createElement('canvas');c.width=img.width*scale;c.height=img.height*scale
        c.getContext('2d').drawImage(img,0,0,c.width,c.height)
        setImage(c.toDataURL('image/png'))
        imgElRef.current={canvas:c,width:c.width,height:c.height}
      };img.src=e.target.result
    };reader.readAsDataURL(file)
  },[])

  var onDrop=useCallback(function(e){e.preventDefault();e.currentTarget.classList.remove('drag');handleFile(e.dataTransfer.files[0])},[handleFile])

  var analyze=async function(){
    if(!imgElRef.current)return
    setLoading(true);setError(null);setAnalysis(null)
    try{
      var ic=imgElRef.current.canvas,w=imgElRef.current.width,h=imgElRef.current.height
      var pd=ic.getContext('2d').getImageData(0,0,w,h)
      var wd=detectWalls(pd,w,h)
      var rooms=detectRooms(wd.horizontal,wd.vertical)

      var aiData=null,ppm=null
      try{
        var apiKey=import.meta.env.VITE_ANTHROPIC_API_KEY
        if(apiKey){
          var b64=ic.toDataURL('image/jpeg',0.85).split(',')[1]
          var resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body:JSON.stringify({model:MODEL,max_tokens:2048,messages:[{role:'user',content:[
              {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
              {type:'text',text:LABEL_PROMPT}
            ]}]})
          })
          if(resp.ok){
            var data=await resp.json();var txt='';data.content.forEach(function(b){txt+=(b.text||'')})
            aiData=JSON.parse(txt.replace(/```json/g,'').replace(/```/g,'').trim())
          }
        }
      }catch(e2){console.warn('AI err:',e2)}

      if(aiData&&aiData.dimensions)ppm=matchPPM(rooms,aiData.dimensions,w,h)
      if(!ppm){
        var all=wd.horizontal.concat(wd.vertical)
        var mnX=Infinity,mxX=-Infinity;all.forEach(function(wl){mnX=Math.min(mnX,wl.x1,wl.x2);mxX=Math.max(mxX,wl.x1,wl.x2)})
        ppm=(mxX-mnX)/10
      }

      setAnalysis({walls:wd.horizontal.concat(wd.vertical),hWalls:wd.horizontal,vWalls:wd.vertical,
        hCount:wd.horizontal.length,vCount:wd.vertical.length,rooms:rooms,ppm:ppm,aiData:aiData,imgWidth:w,imgHeight:h})
    }catch(err){setError(err.message)}finally{setLoading(false)}
  }

  useEffect(function(){if(analysis&&analysis.walls&&analysis.walls.length>0)drawFloorPlan()},[analysis])

  var drawFloorPlan=function(){
    var canvas=canvasRef.current;if(!canvas||!analysis)return
    var allW=(analysis.hWalls||[]).concat(analysis.vWalls||[]);if(!allW.length)return
    var srcW=analysis.imgWidth,srcH=analysis.imgHeight,ppm=analysis.ppm||80
    var PAD=70,scale=Math.min((900-PAD*2)/srcW,(800-PAD*2)/srcH,1)
    var cw=srcW*scale+PAD*2,ch=srcH*scale+PAD*2
    canvas.width=cw;canvas.height=ch
    var ctx=canvas.getContext('2d');ctx.clearRect(0,0,cw,ch);ctx.fillStyle='#fff';ctx.fillRect(0,0,cw,ch)
    var X=function(p){return PAD+p*scale},Y=function(p){return PAD+p*scale}

    ctx.strokeStyle='#1a1a1a';ctx.lineWidth=Math.max(2.5,4*scale);ctx.lineCap='square'
    allW.forEach(function(w){ctx.beginPath();ctx.moveTo(X(w.x1),Y(w.y1));ctx.lineTo(X(w.x2),Y(w.y2));ctx.stroke()})

    ctx.fillStyle='#2563eb'
    allW.forEach(function(w){
      var dx=w.x2-w.x1,dy=w.y2-w.y1,lp=Math.sqrt(dx*dx+dy*dy),sl=lp*scale
      if(sl<35)return
      var lb=(lp/ppm).toFixed(2)+'m',fs=Math.max(8,Math.min(11,sl/8))
      ctx.font=fs+'px "Segoe UI",system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle'
      var mx=X((w.x1+w.x2)/2),my=Y((w.y1+w.y2)/2)
      if(Math.abs(dy)<2){ctx.fillText(lb,mx,my-10)}
      else{ctx.save();ctx.translate(mx-10,my);ctx.rotate(-Math.PI/2);ctx.fillText(lb,0,0);ctx.restore()}
    })

    ctx.fillStyle='#9ca3af';ctx.font='11px sans-serif';ctx.textAlign='right';ctx.textBaseline='top';ctx.fillText('N \u2191',cw-8,8)
    var matched=(analysis.rooms||[]).filter(function(r){return r.matchedDim}).length
    ctx.fillStyle='#6b7280';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom'
    ctx.fillText(analysis.hCount+'H+'+analysis.vCount+'V | '+matched+' matched | ppm='+(ppm||0).toFixed(1),PAD,ch-8)
  }

  return (
    <div className="fpa-root">
      <header className="fpa-header"><h1>CarpetPlan</h1><p className="fpa-subtitle">Upload a floor plan &rarr; Detect walls &amp; measure</p></header>
      {!image&&(<div className="fpa-upload" onClick={function(){fileRef.current&&fileRef.current.click()}} onDrop={onDrop}
        onDragOver={function(e){e.preventDefault();e.currentTarget.classList.add('drag')}} onDragLeave={function(e){e.currentTarget.classList.remove('drag')}}>
        <input ref={fileRef} type="file" accept="image/*" onChange={function(e){handleFile(e.target.files[0])}}/>
        <span className="fpa-upload-icon">&#x1F4D0;</span><span className="fpa-upload-text">Drop floor plan or click to browse</span></div>)}
      {image&&(<div className="fpa-controls"><img src={image} alt="" className="fpa-preview"/>
        <div className="fpa-buttons">
          <button onClick={analyze} disabled={loading} className="fpa-btn fpa-btn-primary">{loading?'Processing\u2026':'Detect Walls'}</button>
          <button onClick={function(){setImage(null);setAnalysis(null);setError(null);imgElRef.current=null}} className="fpa-btn fpa-btn-secondary">Clear</button>
        </div></div>)}
      {error&&<div className="fpa-error">{error}</div>}
      {loading&&<div className="fpa-loading"><div className="fpa-spinner"/><p>Processing&hellip;</p></div>}
      {analysis&&(<div className="fpa-result">
        <div className="fpa-result-header"><h2>Detected Floor Plan</h2>
          <div className="fpa-result-stats">{analysis.hCount}H&middot;{analysis.vCount}V walls</div></div>
        <div className="fpa-canvas-wrap"><canvas ref={canvasRef} className="fpa-canvas"/></div>
        <details className="fpa-details"><summary>Data</summary>
          <pre className="fpa-json">{JSON.stringify({ppm:analysis.ppm,rooms:(analysis.rooms||[]).length,
            matched:(analysis.rooms||[]).filter(function(r){return r.matchedDim}).map(function(r){return{dim:r.matchedDim.text,wpx:r.widthPx,hpx:r.heightPx,ppmX:Math.round(r.ppmX*10)/10,ppmY:Math.round(r.ppmY*10)/10}}),
            aiDims:analysis.aiData?analysis.aiData.dimensions:null},null,2)}</pre></details>
      </div>)}
    </div>
  )
}
