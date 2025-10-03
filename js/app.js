// /js/app.js
// Why: single shared runtime for index.html, index-part2.html, index-part3.html (GitHub Pages-friendly).
(function(){
  "use strict";

  /* ========== Utils ========== */
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
  const wrap=d=>(d%360+360)%360;
  const angDelta=(a,b)=>((b-a+540)%360)-180;
  const raf=typeof requestAnimationFrame==='function'?requestAnimationFrame.bind(window):(fn)=>setTimeout(fn,16);
  const isSecure=typeof isSecureContext==='boolean'?isSecureContext:location.protocol==='https:';

  /* ========== Persistent settings ========== */
  const LS_KEY_OFFSET='heading_offset_deg_v1';
  const LS_KEY_WAYPOINTS='waypoints_v1';
  const storage={
    read:(k,f)=>{ try{ const r=localStorage.getItem(k); return r==null?f:r; }catch{ return f; } },
    write:(k,v)=>{ try{ localStorage.setItem(k,v); }catch{} }
  };
  let headingOffset=clamp(Math.round(parseFloat(storage.read(LS_KEY_OFFSET,'0'))),-45,45);
  let offsetSaveTimer=null;
  const scheduleOffsetSave=v=>{
    if(offsetSaveTimer) clearTimeout(offsetSaveTimer);
    offsetSaveTimer=setTimeout(()=>{ storage.write(LS_KEY_OFFSET,String(v)); offsetSaveTimer=null; },180);
  };

  /* ========== DOM refs ========== */
  const $ = (id)=>document.getElementById(id);
  const gpsDot=$('gpsDot');
  const compassDot=$('compassDot');
  const bearingReadout=$('bearingReadout');
  const btnGPS=$('btnGPS');
  const btnCompass=$('btnCompass');
  const offsetSlider=$('offset');
  const offsetVal=$('offsetVal');
  const statusMsg=$('statusMsg');

  // Waypoints UI
  const fab=$('fab');
  const wpPanel=$('wpPanel');
  const wpClose=$('wpClose');
  const wpName=$('wpName');
  const wpCoords=$('wpCoords');
  const wpAdd=$('wpAdd');
  const wpClear=$('wpClear');
  const wpList=$('wpList');

  let statusTimer=null;
  const showStatus=(message,{tone='info',duration=4500}={})=>{
    if(!statusMsg) return;
    clearTimeout(statusTimer);
    statusMsg.textContent=String(message||'');
    statusMsg.className='status-msg ' + (tone==='error'?'error':tone==='ok'?'ok':'');
    if(duration>0){
      statusTimer=setTimeout(()=>{ statusMsg.textContent=''; statusMsg.className='status-msg'; },duration);
    }
  };

  /* ========== Map init ========== */
  const mapContainer = document.getElementById('map');
  let map=null, geolocate=null;

  if(mapContainer && typeof maplibregl==='object'){
    const style={
      version:8,
      sources:{ osm:{ type:'raster', tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize:256, attribution:'© OpenStreetMap contributors' } },
      layers:[{ id:'osm', type:'raster', source:'osm' }]
    };
    try{
      map=new maplibregl.Map({
        container:'map',
        style,
        center:[-118.5,34.9],
        zoom:16,
        pitch:0,
        bearing:0,
        dragRotate:false,
        pitchWithRotate:false
      });
      map.addControl(new maplibregl.NavigationControl({visualizePitch:false}), 'top-right');

      geolocate = new maplibregl.GeolocateControl({
        positionOptions:{ enableHighAccuracy:true, maximumAge:0 },
        trackUserLocation:true,
        showAccuracyCircle:false,
        showUserHeading:true,
        fitBoundsOptions:{ maxZoom:18 }
      });
      map.addControl(geolocate,'top-right');

      map.on('load',()=>{
        map.getCanvas().style.touchAction='manipulation';
          map.dragPan.enable(); map.scrollZoom.enable(); map.keyboard.enable();
          map.touchZoomRotate.enable(); map.touchZoomRotate.disableRotation(); map.dragRotate.disable();

          // If the Permissions API indicates geolocation is already allowed, start geolocate automatically.
          (async ()=>{
            try{
              if(navigator.permissions && typeof navigator.permissions.query==='function'){
                const p = await navigator.permissions.query({name:'geolocation'});
                if(p.state==='granted'){
                  try{ geolocate.trigger(); }
                  catch(e){
                    try{ navigator.geolocation.getCurrentPosition(()=>{ try{ geolocate.trigger(); }catch{} }, ()=>{}); }catch{};
                  }
                }
              }
            }catch(e){}
          })();

          reapplyBearing({deferFrames:1});
          rebuildWaypoints();
      });
    }catch{
      showStatus('Map rendering not supported in this browser.',{tone:'error',duration:0});
    }
  }

  /* ========== Offset UI ========== */
  if(offsetSlider && offsetVal){
    offsetSlider.value=String(headingOffset);
    offsetVal.textContent=String(headingOffset);
    offsetSlider.addEventListener('input',e=>{
      headingOffset=clamp(parseInt(e.target.value||'0',10),-45,45);
      offsetVal.textContent=String(headingOffset);
      scheduleOffsetSave(headingOffset);
      reapplyBearing();
    });
  }

  /* ========== Permission & state ========== */
  let gpsGranted=false;
  let isFollowing=false;
  let smoothedBearing=null;
  let lastTs=0;
  let lastRawHeading=null;
  let headingSource=null;
  let lastGPSLocation=null;

  const setFollowUI=active=>{
    isFollowing=!!active;
    if(btnGPS) btnGPS.classList.toggle('tracking',active);
  };
  const markGPS=(ok=true)=>{ gpsGranted=!!ok; if(gpsDot) gpsDot.classList.toggle('ok',!!ok); if(btnGPS) btnGPS.classList.toggle('ready',!!ok); };
  const resetGPS=()=>{ markGPS(false); setFollowUI(false); };
  const markCompass=(ok=true)=>{ if(compassDot) compassDot.classList.toggle('ok',!!ok); if(btnCompass) btnCompass.classList.toggle('ready',!!ok); };
  const resetCompass=()=>{ markCompass(false); };

  const stopFollowing=()=>{ if(!isFollowing) return; setFollowUI(false); try{ geolocate?.stop(); }catch{} };

  if(btnGPS && geolocate){
    // Improved GPS button handler: check for secure context and show helpful message
    btnGPS.addEventListener('click',async()=>{
      if(!isSecure){
        showStatus('GPS requires HTTPS or localhost. Serve the files from a local server (e.g. run: python -m http.server 8000) and open http://localhost:8000', {tone:'error', duration:8000});
        return;
      }
      // If Permissions API is available, surface current state to help debugging
      try{
        if(navigator.permissions && typeof navigator.permissions.query==='function'){
          try{
            const p = await navigator.permissions.query({name:'geolocation'});
            if(p.state==='denied'){
              showStatus('Location permission is denied for this site. Please enable location in your browser settings.',{tone:'error',duration:7000});
              return;
            }
          }catch(e){ /* ignore permission query errors */ }
        }
      }catch(e){}

      try{
        geolocate.trigger();
      }catch(err){
        // Try to call the Geolocation API directly to surface a clearer browser prompt/error
        try{
          navigator.geolocation.getCurrentPosition(()=>{ try{ geolocate.trigger(); }catch{} }, (gErr)=>{ showStatus('Unable to access GPS: '+(gErr && gErr.message?gErr.message:'permission denied'),{tone:'error'}); resetGPS(); });
        }catch(inner){
          showStatus('Unable to access GPS: ' + (err && err.message ? err.message : ''), {tone:'error', duration:6000});
        }
      }
    });
    geolocate.on('trackuserlocationstart',()=>{ markGPS(); setFollowUI(true); });
    geolocate.on('trackuserlocationend',()=>{ setFollowUI(false); });
    let didInitialCenter = false;
    geolocate.on('geolocate',(pos)=>{
      markGPS();
      if(pos?.coords){ lastGPSLocation={ latitude: pos.coords.latitude, longitude: pos.coords.longitude }; }
      // If user isn't actively following yet, center/zoom to the location on the first geolocate event
      try{
        if(!isFollowing && !didInitialCenter && pos?.coords){
          didInitialCenter = true;
          const lon = pos.coords.longitude, lat = pos.coords.latitude;
          try{ map.easeTo({ center:[lon,lat], zoom:18, duration:800 }); }catch{}
          setFollowUI(true);
        }
      }catch(e){}
      maybeUseCourseHeading(pos);
    });
    geolocate.on('error',()=>{ showStatus('Unable to access GPS right now.',{tone:'error'}); resetGPS(); });
    map?.on('dragstart',()=>stopFollowing());
  }

  /* ========== Heading-up ========== */
  const screenAngle=()=>{
    if(screen?.orientation&&typeof screen.orientation.angle==='number') return screen.orientation.angle;
    if(typeof window.orientation==='number') return window.orientation;
    return 0;
  };

  let pending=null, afId=0;
  const scheduleBearing=(deg,{reset=false}={})=>{
    lastRawHeading=deg;
    pending={deg,reset};
    if(!afId) afId=raf(()=>{
      if(pending){ applyBearing(pending.deg,{reset:pending.reset}); pending=null; }
      afId=0;
    });
  };

  const applyBearing=(deg,{reset=false}={})=>{
    const corrected=wrap(deg+headingOffset-screenAngle());
    const now=performance.now();
    if(reset||smoothedBearing==null) smoothedBearing=corrected;
    else{
      const dt=Math.max(1,now-lastTs);
      const delta=angDelta(smoothedBearing,corrected);
      const t=Math.min(.28,Math.max(.07,dt/190)); // Why: avoid jitter while staying responsive
      smoothedBearing=wrap(smoothedBearing+delta*t);
    }
    lastTs=now;

    if(bearingReadout) bearingReadout.textContent = Math.round(wrap(smoothedBearing))+'°';
    if(typeof smoothedBearing==='number' && isFinite(smoothedBearing) && map){
      try{ map.setBearing(smoothedBearing,{animate:false}); }catch{}
      updateHeadingLine(smoothedBearing);
    }else{
      updateHeadingLine(null);
    }
  };

  const reapplyBearing=({deferFrames=0}={})=>{
    const apply=()=> scheduleBearing((lastRawHeading==null?0:lastRawHeading),{reset:true});
    if(deferFrames>0){
      let n=deferFrames; const tick=()=>{ if(n--<=0) apply(); else raf(tick); }; tick();
    }else apply();
  };

  const goodAcc=e=> typeof e.webkitCompassAccuracy==='number' ? (e.webkitCompassAccuracy<=60) : true;
  const readHeading=e=>{
    if(typeof e?.webkitCompassHeading==='number'&&isFinite(e.webkitCompassHeading)) return wrap(e.webkitCompassHeading);
    if(typeof e?.alpha==='number'&&isFinite(e.alpha)) return wrap(360-e.alpha);
    return null;
  };

  function onOrient(e){
    const h=readHeading(e);
    if(h==null||!goodAcc(e)) return;
    if(headingSource!=='compass'){ headingSource='compass'; markCompass(); showStatus('Using compass heading.',{tone:'ok'}); }
    scheduleBearing(h);
  }

  const SPEED_MS_MOVING=1.2;
  function maybeUseCourseHeading(pos){
    const {heading:sCourse,speed} = pos?.coords||{};
    const moving = typeof speed==='number' && isFinite(speed) && speed>=SPEED_MS_MOVING;
    const hasCourse = typeof sCourse==='number' && isFinite(sCourse);
    if(pos?.coords){ lastGPSLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }; }
    if(moving && hasCourse){
      if(headingSource!=='course'){ headingSource='course'; showStatus('Using GPS course (moving).',{tone:'ok'}); }
      scheduleBearing(wrap(sCourse));
    }
  }

  async function enableCompass(){
    try{
      if(!isSecure) throw new Error('insecure');
      // iOS 13+ permission
      if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){
        const r=await DeviceOrientationEvent.requestPermission();
        if(r!=='granted') throw new Error('denied');
      }
      attachOrientation();
    }catch{
      showStatus('Compass unavailable. Use HTTPS and tap "Enable Compass" on iPhone.',{tone:'error',duration:7000});
      resetCompass();
    }
  }

  function attachOrientation(){
    window.removeEventListener('deviceorientation',onOrient);
    window.removeEventListener('deviceorientationabsolute',onOrient);
    window.addEventListener('deviceorientation',onOrient,{passive:true});
    window.addEventListener('deviceorientationabsolute',onOrient,{passive:true});
    markCompass();
  }

  btnCompass?.addEventListener('click',enableCompass);
  attachOrientation();

  const handleOrientationReset=()=>{ reapplyBearing(); reapplyBearing({deferFrames:2}); };
  window.addEventListener('orientationchange',handleOrientationReset);
  if(screen?.orientation?.addEventListener){ screen.orientation.addEventListener('change',handleOrientationReset); }

  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ attachOrientation(); reapplyBearing({deferFrames:1}); } });

  /* ========== Fallback custom pinch zoom (edge iOS cases) ========== */
  if(map){
    let pinchRef=null;
    const container=map.getCanvasContainer();
    const dist=t=> Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    container.addEventListener('touchstart',ev=>{ if(ev.touches?.length===2){ pinchRef = { d:dist(ev.touches), zoom: map.getZoom() }; } },{passive:true});
    container.addEventListener('touchmove',ev=>{ if(pinchRef && ev.touches?.length===2){ const ratio = dist(ev.touches)/pinchRef.d; const target = clamp(pinchRef.zoom + Math.log2(ratio), 2, 21); map.easeTo({ zoom: target, duration: 0 }); } },{passive:true});
    container.addEventListener('touchend',()=>{ pinchRef=null; },{passive:true});
  }

  /* ========== Waypoints ========== */
  const WP_KEY = LS_KEY_WAYPOINTS;

  let markers=new Map();
  function addMarker(id,coords){
    if(!map || !coords) return;
    const el=document.createElement('div');
    el.className='wp-marker';
    el.style.width='10px'; el.style.height='10px'; el.style.borderRadius='50%';
    el.style.background='rgba(178,255,189,.9)'; el.style.boxShadow='0 0 8px rgba(178,255,189,.6)';
    const m=new maplibregl.Marker(el).setLngLat([coords.lon, coords.lat]).addTo(map);
    markers.set(id,m);
    return m;
  }
  function removeMarker(id){ const m=markers.get(id); if(m){ try{ m.remove(); }catch{} } markers.delete(id); }
  function flyToWaypoint(coords){ try{ map?.easeTo({ center:[coords.lon,coords.lat], zoom:18, duration:750 }); }catch{} }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  const fmtCoord=c=> `${c.lat>=0?c.lat.toFixed(4)+' N':(-c.lat).toFixed(4)+' S'}, ${c.lon>=0?c.lon.toFixed(4)+' E':(-c.lon).toFixed(4)+' W'}`;

  function loadWaypoints(){ try{ const raw=localStorage.getItem(WP_KEY); return raw?JSON.parse(raw):[]; }catch{return[]} }
  function saveWaypoints(list){ try{ localStorage.setItem(WP_KEY, JSON.stringify(list)); }catch{} }
  function nextId(){ return 'wp_'+Math.random().toString(36).slice(2,10); }

  function parseLatLon(input){
    if(!input) return null;
    let s=String(input).trim().replace(/[()]/g,'').replace(/;/g,',').replace(/\s+/g,' ').replace(/\s*,\s*/g,',');
    s = s.replace(/°|º|&deg;/g,'');
    const tokens = s.split(/[,\s]+/).filter(Boolean);
    const hasCard = /[NSEW]/i.test(s);
    const toNum=(t)=>{ const v=parseFloat(t); return isFinite(v)?v:NaN; };
    const isLatVal=v=> v>=-90 && v<=90;
    const isLonVal=v=> v>=-180 && v<=180;

    const parseSigned=()=>{
      if(tokens.length!==2) return null;
      const a=toNum(tokens[0]), b=toNum(tokens[1]);
      if(isNaN(a)||isNaN(b)) return null;
      if(!isLatVal(a)||!isLonVal(b)) return null;
      return {lat:a, lon:b};
    };

    const parseCardinal=()=>{
      const pairs=[];
      for(let i=0;i<tokens.length-1;i++){
        const A=tokens[i].toUpperCase(), B=tokens[i+1].toUpperCase();
        if(/[NS]/.test(A) && !isNaN(toNum(B))) pairs.push([A,toNum(B)]);
        if(!isNaN(toNum(A)) && /[EW]/.test(B)) pairs.push([B,toNum(A)]);
      }
      if(pairs.length<2) return null;
      let lat=null, lon=null;
      for(const [dir,val] of pairs){
        if(/[NS]/.test(dir) && isLatVal(val)) lat = dir==='S' ? -Math.abs(val) : Math.abs(val);
        if(/[EW]/.test(dir) && isLonVal(val)) lon = dir==='W' ? -Math.abs(val) : Math.abs(val);
      }
      if(lat==null || lon==null) return null;
      return {lat, lon};
    };

    return hasCard ? parseCardinal() : parseSigned();
  }

  function rebuildWaypoints(){
    if(!wpList) return;
    wpList.innerHTML='';
    markers.forEach((_,id)=>removeMarker(id));

    const list=loadWaypoints();
    for(const wp of list){
      const row=document.createElement('div');
      row.className='wp-row';
      row.innerHTML = `
        <div class="info">
          <div class="n">${escapeHtml(wp.name||'Untitled')}</div>
          <div class="c">${fmtCoord(wp.coords)}</div>
        </div>
        <div class="actions">
          <button class="btn" data-act="fly">Go</button>
          <button class="btn" data-act="del">Delete</button>
        </div>
      `;
      row.querySelector('[data-act="fly"]').addEventListener('click',()=>{ flyToWaypoint(wp.coords); });
      row.querySelector('[data-act="del"]').addEventListener('click',()=>{ deleteWaypoint(wp.id); });
      wpList.appendChild(row);
      addMarker(wp.id, wp.coords);
    }
  }

  function addWaypoint(name,coords){
    if(!coords) return;
    const list=loadWaypoints();
    list.push({ id: nextId(), name: String(name||'Untitled'), coords });
    saveWaypoints(list);
    rebuildWaypoints();
  }
  function deleteWaypoint(id){
    const list=loadWaypoints().filter(w=>w.id!==id);
    saveWaypoints(list);
    removeMarker(id);
    rebuildWaypoints();
  }

  wpAdd?.addEventListener('click',()=>{
    const name = (wpName?.value||'').trim() || 'Untitled';
    const coords = parseLatLon(wpCoords?.value||'');
    if(!coords){ showStatus('Enter coordinates like "34.1234, -118.5432" or "34.1234 N, 118.5432 W"',{tone:'error'}); return; }
    addWaypoint(name,coords);
    showStatus('Waypoint added.',{tone:'ok'});
  });
  wpClear?.addEventListener('click',()=>{ if(wpName) wpName.value=''; if(wpCoords) wpCoords.value=''; });

  // FAB panel toggle
  if(fab && wpPanel){
    const setOpen=(open)=>{ wpPanel.classList.toggle('open',open); };
    fab.addEventListener('click',()=>setOpen(!wpPanel.classList.contains('open')));
    wpClose?.addEventListener('click',()=>setOpen(false));
    if(window.OPEN_WP_ON_LOAD) setOpen(true);
  }

  // Capture map center on long press (touch)
  if(map){
    let pressTimer=null;
    map.getCanvasContainer().addEventListener('touchstart',()=>{ 
      clearTimeout(pressTimer);
      pressTimer=setTimeout(()=>{ 
        const c=map.getCenter();
        if(wpCoords){
          const latDir = c.lat>=0 ? 'N' : 'S';
          const lonDir = c.lng>=0 ? 'E' : 'W';
          wpCoords.value = `${Math.abs(c.lat).toFixed(4)} ${latDir}, ${Math.abs(c.lng).toFixed(4)} ${lonDir}`;
          showStatus('Captured map center into coordinate field.',{tone:'ok'});
        }
      },650);
    },{passive:true});
    map.getCanvasContainer().addEventListener('touchend',()=>clearTimeout(pressTimer),{passive:true});
  }

  /* ========== Heading line positioning ========== */
  const ARROW_HALF = 32;
  const ARROW_TIP_Y_OFFSET = 4;
  const TIP_OFFSET_PX = ARROW_HALF - ARROW_TIP_Y_OFFSET;

  const headingGraphic = document.getElementById('headingGraphic');
  const headingLine = document.getElementById('headingGraphicLine');
  const arrowEl = document.getElementById('headingGraphicArrow');

  function updateHeadingLine(bearing=null){
    if(!headingGraphic || !headingLine) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipX = vw/2;
    const tipY = vh/2 - TIP_OFFSET_PX; // where the arrow tip should sit
    headingGraphic.setAttribute('viewBox', `0 0 ${vw} ${vh}`);

    // Position the arrow group's top-left so the arrow's internal coordinates align with tipX,tipY
    // The arrow icon is designed in a 64x64 box; translate by (tipX-32, tipY-32).
    const arrowTranslateX = Math.round(tipX - 32);
    const arrowTranslateY = Math.round(tipY - 32);

    // If we have a numeric bearing, rotate the arrow so its tip points along the bearing.
    if(typeof bearing==='number' && isFinite(bearing)){
      // Apply translate then rotate around the arrow's internal center (32,32).
      arrowEl.setAttribute('transform', `translate(${arrowTranslateX}, ${arrowTranslateY}) rotate(${Math.round(bearing)} 32 32)`);
    }else{
      arrowEl.setAttribute('transform', `translate(${arrowTranslateX}, ${arrowTranslateY}) rotate(0 32 32)`);
    }

    if(typeof bearing!=='number' || !isFinite(bearing)){
      // Reset line to a default short vertical line from tip upward
      headingLine.setAttribute('x1', String(Math.round(tipX)));
      headingLine.setAttribute('y1', String(Math.round(tipY)));
      headingLine.setAttribute('x2', String(Math.round(tipX)));
      headingLine.setAttribute('y2', String(Math.round(tipY - Math.max(vw, vh) * 0.15)));
      arrowEl?.classList.remove('aligned');
      headingLine.classList.remove('aligned');
      return;
    }

    const rad = (bearing) * Math.PI/180;
    const far = Math.max(vw, vh) * 1.2;
    const endX = tipX + Math.sin(rad) * (-far);
    const endY = tipY + Math.cos(rad) * (-far);

    headingLine.setAttribute('x1', String(Math.round(tipX)));
    headingLine.setAttribute('y1', String(Math.round(tipY)));
    headingLine.setAttribute('x2', String(Math.round(endX)));
    headingLine.setAttribute('y2', String(Math.round(endY)));

    const upDelta = Math.abs(angDelta(0,bearing));
    const aligned = upDelta<=2;
    if(aligned){ headingLine.classList.add('aligned'); arrowEl?.classList.add('aligned'); }
    else{ headingLine.classList.remove('aligned'); arrowEl?.classList.remove('aligned'); }
  }
  window.addEventListener('resize', updateHeadingLine);
  window.addEventListener('orientationchange', updateHeadingLine);
  updateHeadingLine();

  // Help overlay on part3
  if(window.SHOW_HELP_ON_LOAD){ const h=$('helpOverlay'); if(h){ h.classList.add('open'); } }
})();
