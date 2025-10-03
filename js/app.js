// Compact refactor of app.js — preserves original behavior but with less repetition
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
  const wrap = d => (d%360+360)%360;
  const angDelta = (a,b)=>((b-a+540)%360)-180;
  const raf = typeof requestAnimationFrame==='function'?requestAnimationFrame.bind(window):(f)=>setTimeout(f,16);
  const isSecure = typeof isSecureContext==='boolean'?isSecureContext:location.protocol==='https:';

  // storage
  const LS={off:'heading_offset_deg_v1',wps:'waypoints_v1'};
  const storageRead = (k,d)=>{ try{ const r=localStorage.getItem(k); return r==null?d:JSON.parse(r)?JSON.parse(r):r; }catch{return d} };
  const storageWrite = (k,v)=>{ try{ localStorage.setItem(k, typeof v==='string'?v:JSON.stringify(v)); }catch{} };

  // DOM
  const gpsDot=$('gpsDot'), compassDot=$('compassDot'), bearingReadout=$('bearingReadout');
  const btnGPS=$('btnGPS'), btnCompass=$('btnCompass');
  const offset=$('offset'), offsetVal=$('offsetVal'), statusMsg=$('statusMsg');
  const fab=$('fab'), wpPanel=$('wpPanel'), wpClose=$('wpClose'), wpName=$('wpName'), wpCoords=$('wpCoords'), wpAdd=$('wpAdd'), wpClear=$('wpClear'), wpList=$('wpList');
  const dbgToggle=$('debugToggle'), dbgPanel=$('debugPanel'), dbgList=$('dbgList'), dbgClear=$('dbgClear');

  // state
  let headingOffset = clamp(Math.round(parseFloat(localStorage.getItem(LS.off) || '0')), -45,45);
  let offsetTimer=null; const scheduleOffsetSave=v=>{ clearTimeout(offsetTimer); offsetTimer=setTimeout(()=>{ localStorage.setItem(LS.off,String(v)); offsetTimer=null; },180); };
  let map=null, geolocate=null, gpsGranted=false, isFollowing=false, smoothed=null, lastTs=0, lastRaw=null, headingSource=null, lastGPS=null;

  const showStatus = (m,{tone='info',duration=4500}={})=>{ if(!statusMsg) return; statusMsg.textContent=m||''; statusMsg.className='status-msg '+(tone==='error'?'error':tone==='ok'?'ok':''); if(duration>0) setTimeout(()=>{ if(statusMsg) statusMsg.textContent=''; },duration); };

  // debug
  const MAX_DBG=12; function addDebug(pos){ if(!dbgList) return; try{ const ts=new Date().toLocaleTimeString(); const lat=pos?.coords?.latitude?.toFixed?pos.coords.latitude.toFixed(6):'n/a'; const lon=pos?.coords?.longitude?.toFixed?pos.coords.longitude.toFixed(6):'n/a'; const acc=pos?.coords?.accuracy?Math.round(pos.coords.accuracy)+'m':''; const r=document.createElement('div'); r.className='dbg-row'; r.innerHTML=`<div class="ts">${ts}</div><div class="coords">${lat}, ${lon}</div><div class="meta">${acc}</div>`; dbgList.insertBefore(r, dbgList.firstChild); while(dbgList.children.length>MAX_DBG) dbgList.removeChild(dbgList.lastChild);}catch{} }
  if(dbgToggle) dbgToggle.addEventListener('click',()=>dbgPanel?.classList.toggle('open')); if(dbgClear) dbgClear.addEventListener('click',()=>{ if(dbgList) dbgList.innerHTML=''; });

  // map + geolocation
  if(document.getElementById('map') && typeof maplibregl==='object'){
    try{
      map = new maplibregl.Map({ container:'map', style:{version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256}},layers:[{id:'osm',type:'raster',source:'osm'}]}, center:[-118.5,34.9], zoom:16, pitch:0, bearing:0, dragRotate:false, pitchWithRotate:false });
      map.addControl(new maplibregl.NavigationControl({visualizePitch:false}),'top-right');
      geolocate = new maplibregl.GeolocateControl({ positionOptions:{enableHighAccuracy:true,maximumAge:0}, trackUserLocation:true, showAccuracyCircle:false, showUserHeading:true, fitBoundsOptions:{maxZoom:18} });
      map.addControl(geolocate,'top-right');
      map.on('load',()=>{ map.getCanvas().style.touchAction='manipulation'; map.dragPan.enable(); map.scrollZoom.enable(); map.keyboard.enable(); map.touchZoomRotate.enable(); map.touchZoomRotate.disableRotation(); map.dragRotate.disable(); tryAutoGeolocate(); reapplyBearing({deferFrames:1}); rebuildWaypoints(); });
    }catch(e){ showStatus('Map rendering not supported in this browser.',{tone:'error',duration:0}); }
  }

  async function tryAutoGeolocate(){ if(!geolocate) return; try{ if(navigator.permissions&&navigator.permissions.query){ const p=await navigator.permissions.query({name:'geolocation'}); if(p.state==='granted'){ try{ geolocate.trigger(); }catch{ try{ navigator.geolocation.getCurrentPosition(()=>{ try{ geolocate.trigger(); }catch{} },()=>{}); }catch{} } } } }catch{} }

  // GPS UI
  const setFollowUI = v=>{ isFollowing=!!v; if(btnGPS) btnGPS.classList.toggle('tracking',isFollowing); };
  const markGPS = ok=>{ gpsGranted=!!ok; gpsDot?.classList.toggle('ok',!!ok); btnGPS?.classList.toggle('ready',!!ok); };
  const resetGPS = ()=>{ markGPS(false); setFollowUI(false); };
  btnGPS?.addEventListener('click', async ()=>{
    if(!isSecure){ showStatus('GPS requires HTTPS or localhost. Serve via local server.',{tone:'error',duration:8000}); return; }
    try{ if(navigator.permissions&&navigator.permissions.query){ const p=await navigator.permissions.query({name:'geolocation'}); if(p.state==='denied'){ showStatus('Location permission denied for this site. Enable it in browser settings.',{tone:'error',duration:7000}); return; } } }catch{}
    try{ geolocate.trigger(); }catch(err){ try{ navigator.geolocation.getCurrentPosition(()=>{ try{ geolocate.trigger(); }catch{} }, gErr=>{ showStatus('Unable to access GPS: '+((gErr&&gErr.message)||'permission denied'),{tone:'error'}); resetGPS(); } ); }catch(e){ showStatus('Unable to access GPS.' ,{tone:'error'}); } }
  });

  if(geolocate){ let initial=false; geolocate.on('trackuserlocationstart',()=>{ markGPS(true); setFollowUI(true); }); geolocate.on('trackuserlocationend',()=>setFollowUI(false)); geolocate.on('geolocate',pos=>{ markGPS(true); if(pos?.coords) lastGPS={latitude:pos.coords.latitude,longitude:pos.coords.longitude}; try{ if(!isFollowing && !initial && pos?.coords){ initial=true; map.easeTo({center:[pos.coords.longitude,pos.coords.latitude],zoom:18,duration:800}); setFollowUI(true); } }catch{} try{ addDebug(pos); }catch{} maybeUseCourseHeading(pos); }); geolocate.on('error',()=>{ showStatus('Unable to access GPS right now.',{tone:'error'}); resetGPS(); }); map?.on('dragstart',()=>{ if(isFollowing){ setFollowUI(false); try{ geolocate.stop(); }catch{} } }); }

  // heading smoothing
  const screenAngle = ()=> (screen?.orientation&&typeof screen.orientation.angle==='number')?screen.orientation.angle:(typeof window.orientation==='number'?window.orientation:0);
  let pending=null, afId=0;
  const scheduleBearing=(deg,{reset=false}={})=>{ lastRaw=deg; pending={deg,reset}; if(!afId) afId=raf(()=>{ if(pending){ applyBearing(pending.deg,{reset:pending.reset}); pending=null; } afId=0; }); };
  const applyBearing=(deg,{reset=false}={})=>{ const corrected=wrap(deg+headingOffset-screenAngle()); const now=performance.now(); if(reset||smoothed==null) smoothed=corrected; else{ const dt=Math.max(1,now-lastTs); const delta=angDelta(smoothed,corrected); const t=Math.min(.28,Math.max(.07,dt/190)); smoothed=wrap(smoothed+delta*t); } lastTs=now; if(bearingReadout) bearingReadout.textContent=Math.round(wrap(smoothed))+'°'; if(typeof smoothed==='number' && isFinite(smoothed) && map){ try{ map.setBearing(smoothed,{animate:false}); }catch{} updateHeadingLine(smoothed);} else updateHeadingLine(null); };
  const reapplyBearing=({deferFrames=0}={})=>{ const apply=()=>scheduleBearing((lastRaw==null?0:lastRaw),{reset:true}); if(deferFrames>0){ let n=deferFrames; const tick=()=>{ if(n--<=0) apply(); else raf(tick); }; tick(); } else apply(); };

  // device orientation
  const goodAcc = e => typeof e.webkitCompassAccuracy==='number' ? e.webkitCompassAccuracy<=60 : true;
  const readHeading = e => (typeof e?.webkitCompassHeading==='number'&&isFinite(e.webkitCompassHeading))?wrap(e.webkitCompassHeading):(typeof e?.alpha==='number'&&isFinite(e.alpha)?wrap(360-e.alpha):null);
  function onOrient(e){ const h=readHeading(e); if(h==null||!goodAcc(e)) return; if(headingSource!=='compass'){ headingSource='compass'; compassDot?.classList.add('ok'); showStatus('Using compass heading.',{tone:'ok'}); } scheduleBearing(h); }
  async function enableCompass(){ try{ if(!isSecure) throw 0; if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){ const r=await DeviceOrientationEvent.requestPermission(); if(r!=='granted') throw 0; } attachOrientation(); }catch{ showStatus('Compass unavailable. Use HTTPS and tap "Enable Compass" on iPhone.',{tone:'error',duration:7000}); compassDot?.classList.remove('ok'); } }
  function attachOrientation(){ window.removeEventListener('deviceorientation',onOrient); window.removeEventListener('deviceorientationabsolute',onOrient); window.addEventListener('deviceorientation',onOrient,{passive:true}); window.addEventListener('deviceorientationabsolute',onOrient,{passive:true}); }
  btnCompass?.addEventListener('click',enableCompass); attachOrientation(); const handleOrientationReset=()=>{ reapplyBearing(); reapplyBearing({deferFrames:2}); }; window.addEventListener('orientationchange',handleOrientationReset); if(screen?.orientation?.addEventListener) screen.orientation.addEventListener('change',handleOrientationReset); document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ attachOrientation(); reapplyBearing({deferFrames:1}); } });

  // pinch fallback
  if(map){ let pinchRef=null; const c=map.getCanvasContainer(); const dist=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY); c.addEventListener('touchstart',ev=>{ if(ev.touches?.length===2) pinchRef={d:dist(ev.touches),zoom:map.getZoom()}; },{passive:true}); c.addEventListener('touchmove',ev=>{ if(pinchRef && ev.touches?.length===2){ const ratio=dist(ev.touches)/pinchRef.d; const target=clamp(pinchRef.zoom+Math.log2(ratio),2,21); map.easeTo({zoom:target,duration:0}); } },{passive:true}); c.addEventListener('touchend',()=>pinchRef=null,{passive:true}); }

  // waypoints
  const WP=LS.wps; let markers=new Map(); const addMarker=(id,coords)=>{ if(!map||!coords) return; const el=document.createElement('div'); el.className='wp-marker'; el.style.cssText='width:10px;height:10px;border-radius:50%;background:rgba(178,255,189,.9);box-shadow:0 0 8px rgba(178,255,189,.6)'; const m=new maplibregl.Marker(el).setLngLat([coords.lon,coords.lat]).addTo(map); markers.set(id,m); return m; }; const removeMarker=id=>{ const m=markers.get(id); if(m){ try{ m.remove(); }catch{} } markers.delete(id); };
  const flyToWaypoint=coords=>{ try{ map?.easeTo({center:[coords.lon,coords.lat],zoom:18,duration:750}); }catch{} };
  const fmtCoord = c => `${c.lat>=0?c.lat.toFixed(4)+' N':(-c.lat).toFixed(4)+' S'}, ${c.lon>=0?c.lon.toFixed(4)+' E':(-c.lon).toFixed(4)+' W'}`;
  const loadWaypoints = ()=>{ try{ const r=localStorage.getItem(WP); return r?JSON.parse(r):[] }catch{return []} };
  const saveWaypoints = l => { try{ localStorage.setItem(WP,JSON.stringify(l)); }catch{} };
  const nextId = ()=> 'wp_'+Math.random().toString(36).slice(2,10);
  const esc = s => String(s).replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function parseLatLon(input){ if(!input) return null; let s=String(input).trim().replace(/[()]/g,'').replace(/;/g,',').replace(/ /g,''); s=s.replace(/°|º|&deg;/g,''); s=s.replace(/ /g,''); const tokens=s.split(/[,\s]+/).filter(Boolean); const hasCard= /[NSEW]/i.test(s); const toNum=t=>{ const v=parseFloat(t); return isFinite(v)?v:NaN }; const isLat=v=>v>=-90&&v<=90; const isLon=v=>v>=-180&&v<=180; if(!hasCard){ if(tokens.length!==2) return null; const a=toNum(tokens[0]), b=toNum(tokens[1]); if(isNaN(a)||isNaN(b)) return null; if(!isLat(a)||!isLon(b)) return null; return {lat:a,lon:b}; } let pairs=[]; for(let i=0;i<tokens.length-1;i++){ const A=tokens[i].toUpperCase(), B=tokens[i+1].toUpperCase(); if(/[NS]/.test(A)&&!isNaN(toNum(B))) pairs.push([A,toNum(B)]); if(!isNaN(toNum(A))&&/[EW]/.test(B)) pairs.push([B,toNum(A)]); } if(pairs.length<2) return null; let lat=null,lon=null; for(const [dir,val] of pairs){ if(/[NS]/.test(dir)&&isLat(val)) lat = dir==='S'?-Math.abs(val):Math.abs(val); if(/[EW]/.test(dir)&&isLon(val)) lon = dir==='W'?-Math.abs(val):Math.abs(val); } if(lat==null||lon==null) return null; return {lat,lon}; }
  function rebuildWaypoints(){ if(!wpList) return; wpList.innerHTML=''; markers.forEach((_,id)=>removeMarker(id)); const list=loadWaypoints(); for(const wp of list){ const row=document.createElement('div'); row.className='wp-row'; row.innerHTML=`<div class="info"><div class="n">${esc(wp.name||'Untitled')}</div><div class="c">${fmtCoord(wp.coords)}</div></div><div class="actions"><button class="btn" data-act="fly">Go</button><button class="btn" data-act="del">Delete</button></div>`; row.querySelector('[data-act="fly"]').addEventListener('click',()=>flyToWaypoint(wp.coords)); row.querySelector('[data-act="del"]').addEventListener('click',()=>{ const list=loadWaypoints().filter(w=>w.id!==wp.id); saveWaypoints(list); removeMarker(wp.id); rebuildWaypoints(); }); wpList.appendChild(row); addMarker(wp.id,wp.coords); } }
  if(wpAdd) wpAdd.addEventListener('click',()=>{ const name=(wpName?.value||'').trim()||'Untitled'; const coords=parseLatLon(wpCoords?.value||''); if(!coords){ showStatus('Enter coordinates like "34.1234, -118.5432" or "34.1234 N, 118.5432 W"',{tone:'error'}); return; } const list=loadWaypoints(); list.push({id:nextId(),name,coords}); saveWaypoints(list); rebuildWaypoints(); showStatus('Waypoint added.',{tone:'ok'}); });
  if(wpClear) wpClear.addEventListener('click',()=>{ if(wpName) wpName.value=''; if(wpCoords) wpCoords.value=''; });
  if(fab && wpPanel){ const setOpen=o=>wpPanel.classList.toggle('open',o); fab.addEventListener('click',()=>setOpen(!wpPanel.classList.contains('open'))); wpClose?.addEventListener('click',()=>setOpen(false)); if(window.OPEN_WP_ON_LOAD) setOpen(true); }
  if(map){ let pressTimer=null; map.getCanvasContainer().addEventListener('touchstart',()=>{ clearTimeout(pressTimer); pressTimer=setTimeout(()=>{ const c=map.getCenter(); if(wpCoords){ const latDir=c.lat>=0?'N':'S'; const lonDir=c.lng>=0?'E':'W'; wpCoords.value=`${Math.abs(c.lat).toFixed(4)} ${latDir}, ${Math.abs(c.lng).toFixed(4)} ${lonDir}`; showStatus('Captured map center into coordinate field.',{tone:'ok'}); } },650); },{passive:true}); map.getCanvasContainer().addEventListener('touchend',()=>clearTimeout(pressTimer),{passive:true}); }

  // heading graphic
  const ARROW_HALF=32, ARROW_TIP_Y_OFFSET=4, TIP_OFFSET_PX=ARROW_HALF-ARROW_TIP_Y_OFFSET;
  const headingGraphic=$('headingGraphic'), headingLine=$('headingGraphicLine'), arrowEl=$('headingGraphicArrow');
  function updateHeadingLine(bearing=null){ if(!headingGraphic||!headingLine) return; const vw=innerWidth, vh=innerHeight; const tipX=vw/2, tipY=vh/2-TIP_OFFSET_PX; headingGraphic.setAttribute('viewBox',`0 0 ${vw} ${vh}`); const tx=Math.round(tipX-32), ty=Math.round(tipY-32); if(typeof bearing==='number'&&isFinite(bearing)) arrowEl.setAttribute('transform',`translate(${tx}, ${ty}) rotate(${Math.round(bearing)} 32 32)`); else arrowEl.setAttribute('transform',`translate(${tx}, ${ty}) rotate(0 32 32)`); if(typeof bearing!=='number' || !isFinite(bearing)){ headingLine.setAttribute('x1',String(Math.round(tipX))); headingLine.setAttribute('y1',String(Math.round(tipY))); headingLine.setAttribute('x2',String(Math.round(tipX))); headingLine.setAttribute('y2',String(Math.round(tipY-Math.max(vw,vh)*0.15))); arrowEl?.classList.remove('aligned'); headingLine.classList.remove('aligned'); return; } const rad=bearing*Math.PI/180, far=Math.max(vw,vh)*1.2, endX=tipX+Math.sin(rad)*(-far), endY=tipY+Math.cos(rad)*(-far); headingLine.setAttribute('x1',String(Math.round(tipX))); headingLine.setAttribute('y1',String(Math.round(tipY))); headingLine.setAttribute('x2',String(Math.round(endX))); headingLine.setAttribute('y2',String(Math.round(endY))); const aligned=Math.abs(angDelta(0,bearing))<=2; headingLine.classList.toggle('aligned',aligned); arrowEl?.classList.toggle('aligned',aligned); }
  addEventListener('resize', updateHeadingLine); addEventListener('orientationchange', updateHeadingLine); updateHeadingLine(); if(window.SHOW_HELP_ON_LOAD){ const h=$('helpOverlay'); if(h) h.classList.add('open'); }

})();
