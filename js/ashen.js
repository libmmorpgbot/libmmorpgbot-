// ─────────────────────────────────────────────────────────
//  «ПЕПЕЛЬНЫЙ КРАЙ» — ВИД ЛОКАЦИЙ И МОНСТРОВ
// ─────────────────────────────────────────────────────────
// Перенесено из одиночной игры «Пепельный край» (ashen-edge.html): биомы
// (лес, топи, погост, пустоши, крепость, перевал, бездна), их земля, дорога,
// декор — деревья, ели, скалы, могилы, кристаллы, жаровни — и пиксельные
// монстры 0x72 «16x16 Dungeon Tileset» (CC0, images/ae/atlas.png).
//
// Геометрия этажей не меняется: стены остаются стенами сервера
// (dungeon.grid). Меняется только то, что нарисовано в чанках пола
// (_buildChunk, js/game.js → zonesDrawGround, js/zones.js): клетка-стена
// становится землёй биома с деревом/скалой на ней, проход между комнатами —
// дорогой, комната — поляной. Всё детерминировано хэшем клетки (_zh), поэтому
// соседние чанки стыкуются без швов.

const AE_SL = {"npc_knight_green":[208,236,15,20],"npc_knight_blue":[224,236,15,20],"npc_knight_yellow":[192,236,15,20],"npc_paladin":[240,236,15,20],"npc_sage":[98,224,12,16],"npc_merchant":[98,240,13,16],"npc_dwarf":[128,241,16,15],"monster_elemental_plant":[67,192,10,16],"monster_goblin":[2,166,10,10],"monster_skelet":[19,146,10,14],"monster_imp":[3,180,10,12],"monster_chort":[50,176,11,16],"monster_demon":[133,178,22,30],"weapon_sword_rusty":[163,10,10,21],"weapon_sword_steel":[179,10,10,21],"weapon_sword_ruby":[195,10,10,21],"weapon_sword_golden":[147,42,10,21],"floor_plain":[32,48,16,16],"floor_stain_1":[0,32,16,16],"floor_stain_2":[16,32,16,16],"floor_stain_3":[32,32,16,16],"floor_light":[64,112,16,16],"column":[208,181,16,43],"skull":[21,55,6,6],"box":[80,107,16,21],"boxes_stacked":[96,96,16,32],"chest_closed":[224,178,16,14],"chest_golden_closed":[240,178,16,14],"floor_gargoyle_red_basin":[0,80,16,16],"flask_big_red":[196,180,9,11],"flask_big_blue":[196,212,9,11],"torch_1":[132,154,8,20],"torch_2":[148,153,8,21],"torch_3":[164,154,8,20],"torch_4":[180,153,8,21],"torch_5":[196,153,8,21],"torch_6":[212,154,8,20],"torch_7":[228,155,8,19],"torch_8":[244,155,8,19],"monster_bat":[64,144,16,9],"monster_zombie":[36,144,8,16],"monster_zombie_green":[52,144,8,16],"monster_zombie_small":[3,150,9,10],"monster_zombie_tall":[35,224,10,16],"monster_elemental_goo":[80,195,16,13],"monster_necromancer":[82,144,13,16],"monster_elemental_fire":[34,192,12,16],"monster_bies":[34,176,11,16],"monster_orc":[34,160,11,16],"monster_orc_masked":[18,161,12,15],"monster_orc_armored":[49,160,13,16],"monster_orc_veteran":[65,161,13,15],"monster_orc_shaman":[82,161,11,15],"monster_dark_knight":[96,139,16,21],"monster_elemental_water":[17,192,15,16],"monster_elemental_air":[51,192,10,16],"monster_elemental_earth":[1,192,13,16],"monster_wogol":[19,176,10,16],"monster_demonolog":[82,176,13,16],"monster_rokita":[66,176,12,16],"monster_tentackle":[160,177,32,31],"monster_ogre":[102,182,20,26],"wall_flag_red":[192,64,16,16],"wall_flag_blue":[224,64,16,16],"floor_gargoyle_red_puddle":[48,80,16,16],"npc_elf":[162,241,12,15],"monster_elemental_fire_small":[35,213,9,11],"monster_elemental_plant_small":[67,214,10,10],"monster_elemental_water_small":[18,214,11,10],"monster_elemental_air_small":[51,214,9,10],"monster_elemental_earth_small":[3,214,9,10],"monster_elemental_goo_small":[81,215,13,9],"npc_elf_2":[177,240,15,16]};

// Атлас грузится сразу. Чанки, запечённые до его прихода, остались без
// черепов и колонн из атласа — поэтому по приходу их пересобираем.
let _aeAtlas = null, _aeWhite = null;
if (typeof Image !== 'undefined') {
  _aeAtlas = new Image();
  _aeAtlas.onload = () => {
    try {
      const w = document.createElement('canvas');
      w.width = _aeAtlas.width; w.height = _aeAtlas.height;
      const g = w.getContext('2d');
      if (g) {
        g.drawImage(_aeAtlas, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = '#fff'; g.fillRect(0, 0, w.width, w.height);
        _aeWhite = w;
      }
    } catch (e) { /* без белой копии просто нет вспышки */ }
    if (typeof _zoneLayout === 'function' && _zoneLayout() && _zoneLayout().ae
        && typeof buildTileCanvas === 'function') buildTileCanvas();
  };
  _aeAtlas.src = '/images/ae/atlas.png';
}
function _aeAtlasReady() { return !!(_aeAtlas && _aeAtlas.complete && _aeAtlas.naturalWidth); }

// Спрайт из атласа, привязанный к середине нижнего края.
function _aeSpr(c, n, x, y, sc, o) {
  const s = AE_SL[n];
  if (!s || !_aeAtlasReady()) return;
  o = o || {};
  c.save(); c.translate(x, y); if (o.rot) c.rotate(o.rot);
  c.scale((o.flip ? -1 : 1) * sc * (o.sx || 1), sc * (o.sy || 1));
  c.imageSmoothingEnabled = false;
  c.drawImage(_aeAtlas, s[0], s[1], s[2], s[3], -s[2] / 2, -s[3], s[2], s[3]);
  if (o.flash && _aeWhite) { c.globalAlpha *= 0.8; c.drawImage(_aeWhite, s[0], s[1], s[2], s[3], -s[2] / 2, -s[3], s[2], s[3]); }
  c.restore();
}
function _aeShadow(c, x, y, r, a) {
  c.fillStyle = `rgba(0,0,0,${a || 0.32})`;
  c.beginPath(); c.ellipse(x, y, r, r * 0.42, 0, 0, 7); c.fill();
}

// ── Предметы и мелочь на земле — код «Пепельного края» почти дословно ──
// (drawDeco/drawFlat). now=0: в чанк запекается один кадр, огонь живёт
// отдельно (_updateLights).
function _aeFlatDraw(cx,f){const now=0;
  if(f.type==='flower'){cx.fillStyle=f.c;cx.fillRect(f.x,f.y,3,3);cx.fillStyle='#ffffff66';cx.fillRect(f.x+1,f.y,1,1)}
  else if(f.type==='mush'){cx.fillStyle='#e8dcc8';cx.fillRect(f.x,f.y,2,4);cx.fillStyle='#b8402e';cx.beginPath();cx.arc(f.x+1,f.y,4,Math.PI,0);cx.fill()}
  else if(f.type==='fence'){cx.fillStyle='#5a4230';cx.fillRect(f.x,f.y-14,4,16);cx.fillRect(f.x-2,f.y-10,28,3);cx.fillRect(f.x-2,f.y-4,28,3)}
  else if(f.type==='bones'){cx.strokeStyle='#cfc6b2';cx.globalAlpha=.6;cx.lineWidth=2;cx.beginPath();cx.moveTo(f.x,f.y);cx.lineTo(f.x+10*Math.cos(f.v*6),f.y+6*Math.sin(f.v*6));cx.stroke();cx.globalAlpha=1}
  else if(f.type==='skull'){cx.globalAlpha=.85;_aeSpr(cx,'skull',f.x,f.y,1.8,{flip:f.v<.5});cx.globalAlpha=1}
  else if(f.type==='pool'){const p=.5+Math.sin(now*1.3+f.v*9)*.1;cx.fillStyle='#0b1814';cx.beginPath();cx.ellipse(f.x,f.y,f.r*1.4,f.r*.6,0,0,7);cx.fill();cx.strokeStyle=`rgba(110,160,120,${p*.5})`;cx.lineWidth=2;cx.stroke();
    cx.fillStyle=`rgba(150,200,170,${p*.18})`;cx.beginPath();cx.ellipse(f.x-f.r*.3,f.y-f.r*.15,f.r*.5,f.r*.12,0,0,7);cx.fill();cx.fillStyle='#2f4a2a';cx.beginPath();cx.ellipse(f.x+f.r*.4,f.y+f.r*.1,6,3,0,0,7);cx.fill()}
  else if(f.type==='reed'){cx.strokeStyle='#4a5a30';cx.lineWidth=1.5;for(let k=0;k<5;k++){const sw=Math.sin(now*1.6+f.v*9+k)*1.5;cx.beginPath();cx.moveTo(f.x+k*3,f.y);cx.lineTo(f.x+k*3+sw,f.y-14-((k*5+f.v*10)%8));cx.stroke()}cx.fillStyle='#4a3020';cx.fillRect(f.x+5,f.y-20,3,6)}
  else if(f.type==='gmush'){const p=.6+Math.sin(now*2+f.v*9)*.3;cx.fillStyle='#d8e8e0';cx.fillRect(f.x,f.y,2,4);cx.fillRect(f.x+6,f.y+2,2,3);cx.fillStyle=`rgba(90,255,200,${p})`;cx.shadowColor='#5affc8';cx.shadowBlur=8;cx.beginPath();cx.arc(f.x+1,f.y,4,Math.PI,0);cx.arc(f.x+7,f.y+2,3,Math.PI,0);cx.fill();cx.shadowBlur=0}
  else if(f.type==='candles'){for(let k=0;k<3;k++){const cxk=f.x+k*7-7,h=8+k*3;cx.fillStyle='#d8cbb0';cx.fillRect(cxk-1.5,f.y-h,3,h);const fl=Math.sin(now*12+k+f.v*9);cx.fillStyle='#ffb84a';cx.beginPath();cx.ellipse(cxk,f.y-h-3,1.8,3+fl*.6,0,0,7);cx.fill()}cx.fillStyle='rgba(216,203,176,.5)';cx.beginPath();cx.ellipse(f.x,f.y+1,12,3,0,0,7);cx.fill()}
  else if(f.type==='grass2'){cx.strokeStyle='#5a5a48';cx.lineWidth=1;for(let k=0;k<4;k++){cx.beginPath();cx.moveTo(f.x+k*3,f.y);cx.lineTo(f.x+k*3+(k-1.5),f.y-7);cx.stroke()}}
  else if(f.type==='rubble'){cx.fillStyle='#5a5550';for(let k=0;k<4;k++){cx.fillRect(f.x+Math.sin(k*2.3+f.v*9)*10,f.y+Math.cos(k*1.7+f.v*7)*5,5,4)}}
  else if(f.type==='snowdrift'){cx.fillStyle='rgba(240,246,250,.55)';cx.beginPath();cx.ellipse(f.x,f.y,f.r,f.r*.3,0,0,7);cx.fill()}
  else if(f.type==='icepatch'){cx.fillStyle='rgba(200,235,255,.35)';cx.beginPath();cx.ellipse(f.x,f.y,f.r*.9,f.r*.3,f.v,0,7);cx.fill();cx.strokeStyle='rgba(255,255,255,.4)';cx.lineWidth=1;cx.beginPath();cx.moveTo(f.x-f.r*.4,f.y-2);cx.lineTo(f.x+f.r*.2,f.y-5);cx.stroke()}
  else if(f.type==='blood'){const p=.75+Math.sin(now*1.2+f.v*9)*.08;cx.fillStyle=`rgba(80,4,6,${p})`;cx.beginPath();cx.ellipse(f.x,f.y,f.r*1.2,f.r*.5,0,0,7);cx.fill();cx.fillStyle='rgba(200,40,40,.2)';cx.beginPath();cx.ellipse(f.x-f.r*.3,f.y-f.r*.12,f.r*.4,f.r*.1,0,0,7);cx.fill()}
  else if(f.type==='lava'){const p=.7+Math.sin(now*2+f.v*6)*.15;const g=cx.createRadialGradient(f.x,f.y,0,f.x,f.y,f.r*1.5);g.addColorStop(0,`rgba(255,170,70,${p})`);g.addColorStop(.45,`rgba(220,70,20,${p*.8})`);g.addColorStop(1,'rgba(120,20,0,0)');cx.fillStyle=g;cx.beginPath();cx.ellipse(f.x,f.y,f.r*1.5,f.r*1.05,0,0,7);cx.fill();cx.fillStyle='#2a110b';cx.globalAlpha=.6;cx.beginPath();cx.ellipse(f.x+f.r*.3,f.y-f.r*.2,f.r*.25,f.r*.12,0,0,7);cx.fill();cx.globalAlpha=1}
  else if(f.type==='camp'){const fl=Math.sin(now*12)*1.5;cx.fillStyle='#3a2a1c';cx.beginPath();cx.arc(f.x,f.y,16,0,7);cx.fill();const g=cx.createRadialGradient(f.x,f.y-6,0,f.x,f.y-6,60);g.addColorStop(0,'rgba(255,170,70,.35)');g.addColorStop(1,'rgba(255,120,40,0)');cx.fillStyle=g;cx.beginPath();cx.arc(f.x,f.y-6,60,0,7);cx.fill();cx.fillStyle='#ff8a2a';cx.beginPath();cx.moveTo(f.x-8,f.y);cx.quadraticCurveTo(f.x,f.y-22-fl,f.x+8,f.y);cx.fill();cx.fillStyle='#ffd27a';cx.beginPath();cx.moveTo(f.x-4,f.y);cx.quadraticCurveTo(f.x,f.y-12+fl,f.x+4,f.y);cx.fill();
    for(let k=0;k<3;k++){const a=k*2.1+.4;const tx=f.x+Math.cos(a)*44,ty=f.y+Math.sin(a)*30;cx.fillStyle='#6b4a2a';cx.beginPath();cx.moveTo(tx-16,ty+6);cx.lineTo(tx,ty-22);cx.lineTo(tx+16,ty+6);cx.fill();cx.fillStyle='#4a321c';cx.beginPath();cx.moveTo(tx-4,ty+6);cx.lineTo(tx,ty-6);cx.lineTo(tx+4,ty+6);cx.fill()}}
}
function _aeDecoDraw(cx,d){const now=0;
  const x=d.x,y=d.y;
  switch(d.type){
  case 'tree':{_aeShadow(cx,x,y+2,30,.35);cx.fillStyle='#4a3322';cx.fillRect(x-4,y-22,8,24);
    const greens=['#1f3d1e','#2a4d27','#3a6332'];
    const s=1+d.v*.35;cx.fillStyle=greens[0];cx.beginPath();cx.arc(x-12*s,y-34*s,16*s,0,7);cx.arc(x+12*s,y-36*s,15*s,0,7);cx.arc(x,y-50*s,19*s,0,7);cx.fill();
    cx.fillStyle=greens[1];cx.beginPath();cx.arc(x-6*s,y-44*s,13*s,0,7);cx.arc(x+8*s,y-46*s,11*s,0,7);cx.fill();cx.fillStyle=greens[2];cx.beginPath();cx.arc(x-6*s,y-52*s,6*s,0,7);cx.fill();break}
  case 'pine':{_aeShadow(cx,x,y+2,22,.35);cx.fillStyle='#3d2a1c';cx.fillRect(x-3,y-14,6,16);const s=1+d.v*.4;
    for(let k=0;k<3;k++){cx.fillStyle=k%2?'#2f5a34':'#244a2b';const w=(22-k*5)*s,top=y-(16+k*16)*s;cx.beginPath();cx.moveTo(x-w,top+4);cx.lineTo(x,top-22*s);cx.lineTo(x+w,top+4);cx.fill()}
    cx.fillStyle='#3e7246';cx.beginPath();cx.moveTo(x,y-(62)*s-6);cx.lineTo(x+6*s,y-50*s);cx.lineTo(x,y-52*s);cx.fill();break}
  case 'rock':{_aeShadow(cx,x,y+3,22,.3);const c1=d.c1||'#6f7370',c2=d.c2||'#4b4f4d';cx.fillStyle=c2;cx.beginPath();cx.moveTo(x-20,y+2);cx.lineTo(x-16,y-14);cx.lineTo(x-2,y-22);cx.lineTo(x+16,y-16);cx.lineTo(x+21,y);cx.closePath();cx.fill();
    cx.fillStyle=c1;cx.beginPath();cx.moveTo(x-14,y-12);cx.lineTo(x-2,y-20);cx.lineTo(x+12,y-14);cx.lineTo(x+2,y-6);cx.closePath();cx.fill();break}
  case 'dead':{_aeShadow(cx,x,y+2,18,.3);cx.strokeStyle='#2a201c';cx.lineCap='round';cx.lineWidth=6;cx.beginPath();cx.moveTo(x,y);cx.lineTo(x+2,y-40);cx.stroke();cx.lineWidth=3;cx.beginPath();cx.moveTo(x+1,y-26);cx.lineTo(x-16,y-44);cx.moveTo(x+2,y-36);cx.lineTo(x+18,y-54);cx.moveTo(x-9,y-36);cx.lineTo(x-14,y-58);cx.stroke();break}
  case 'crystal':{const p=.6+Math.sin(now*2+d.v*9)*.25;const g=cx.createRadialGradient(x,y-14,0,x,y-14,46);g.addColorStop(0,`rgba(255,120,50,${p*.45})`);g.addColorStop(1,'rgba(255,90,30,0)');cx.fillStyle=g;cx.beginPath();cx.arc(x,y-14,46,0,7);cx.fill();
    cx.fillStyle='#7a2a16';cx.beginPath();cx.moveTo(x-10,y);cx.lineTo(x-4,y-34);cx.lineTo(x+3,y);cx.fill();cx.fillStyle='#e8703a';cx.beginPath();cx.moveTo(x-2,y);cx.lineTo(x+6,y-26);cx.lineTo(x+12,y);cx.fill();cx.fillStyle='#ffc070';cx.beginPath();cx.moveTo(x-4,y-34);cx.lineTo(x-2,y-14);cx.lineTo(x-7,y-12);cx.fill();break}
  case 'house':{const [hx,hy,hw,hh]=d.rect;_aeShadow(cx,hx+hw/2,hy+hh+4,hw*.6,.3);cx.fillStyle='#8a7258';cx.fillRect(hx,hy+20,hw,hh-20);cx.fillStyle='#6d5a45';cx.fillRect(hx,hy+hh-8,hw,8);
    cx.fillStyle='#3a2a1e';cx.fillRect(hx+hw/2-12,hy+hh-38,24,38);cx.fillStyle='#f2c66a';cx.fillRect(hx+18,hy+hh-46,20,16);cx.fillRect(hx+hw-38,hy+hh-46,20,16);
    cx.fillStyle=d.roof;cx.beginPath();cx.moveTo(hx-12,hy+30);cx.lineTo(hx+hw/2,hy-40);cx.lineTo(hx+hw+12,hy+30);cx.closePath();cx.fill();cx.fillStyle='#0003';cx.beginPath();cx.moveTo(hx+hw/2,hy-40);cx.lineTo(hx+hw+12,hy+30);cx.lineTo(hx+hw/2,hy+30);cx.fill();
    cx.fillStyle='#5b5b5b';cx.fillRect(hx+hw-40,hy-20,14,30);break}
  case 'well':{_aeShadow(cx,x,y+6,34,.35);cx.fillStyle='#6f6a63';cx.beginPath();cx.ellipse(x,y-4,30,18,0,0,7);cx.fill();cx.fillStyle='#2a4a6a';cx.beginPath();cx.ellipse(x,y-6,20,11,0,0,7);cx.fill();cx.fillStyle='#8fb6d8';cx.globalAlpha=.5+Math.sin(now*2)*.2;cx.beginPath();cx.ellipse(x-5,y-8,6,2,0,0,7);cx.fill();cx.globalAlpha=1;
    cx.fillStyle='#4a3322';cx.fillRect(x-26,y-46,5,42);cx.fillRect(x+21,y-46,5,42);cx.fillStyle='#7a3b2a';cx.beginPath();cx.moveTo(x-34,y-40);cx.lineTo(x,y-62);cx.lineTo(x+34,y-40);cx.closePath();cx.fill();break}
  case 'stall':{_aeShadow(cx,x,y+4,62,.3);cx.fillStyle='#5a4230';cx.fillRect(x-55,y-36,110,36);cx.fillStyle='#4a3322';cx.fillRect(x-55,y-70,5,70);cx.fillRect(x+50,y-70,5,70);
    for(let k=0;k<6;k++){cx.fillStyle=k%2?'#e8dcc0':'#3f7a5a';cx.beginPath();cx.moveTo(x-60+k*20,y-70);cx.lineTo(x-40+k*20,y-70);cx.lineTo(x-40+k*20,y-56);cx.quadraticCurveTo(x-50+k*20,y-50,x-60+k*20,y-56);cx.fill()}
    ['#d8402f','#3e72dc','#d8402f','#74c15c'].forEach((c,k)=>{cx.fillStyle=c;cx.beginPath();cx.arc(x-36+k*24,y-40,5,0,7);cx.fill()});break}
  case 'anvil':{_aeShadow(cx,x,y+3,18,.3);cx.fillStyle='#3a2a1e';cx.fillRect(x-8,y-12,16,12);cx.fillStyle='#4f5357';cx.beginPath();cx.moveTo(x-18,y-22);cx.lineTo(x+20,y-22);cx.lineTo(x+12,y-14);cx.lineTo(x-12,y-14);cx.fill();break}
  case 'forge':{_aeShadow(cx,x,y+4,30,.35);cx.fillStyle='#55504a';cx.fillRect(x-26,y-40,52,40);const p=.6+Math.sin(now*9)*.2;cx.fillStyle=`rgba(255,140,50,${p})`;cx.fillRect(x-14,y-26,28,16);cx.fillStyle='#3d3935';cx.fillRect(x-8,y-80,16,40);break}
  case 'pillar':{_aeShadow(cx,x,y+4,28,.4);cx.fillStyle='#2b2326';cx.fillRect(x-20,y-110,40,110);cx.fillStyle='#3a2f33';cx.fillRect(x-20,y-110,12,110);cx.fillStyle='#1a1416';cx.fillRect(x-26,y-118,52,12);cx.fillRect(x-26,y-8,52,10);
    const p=.5+Math.sin(now*3+d.v*7)*.3;cx.fillStyle=`rgba(255,110,40,${p})`;cx.fillRect(x-3,y-80,6,18);break}
  case 'column':{_aeShadow(cx,x,y+3,26,.45);_aeSpr(cx,'column',x,y+6,2.6);const p=.35+Math.sin(now*3+d.v*7)*.2;cx.fillStyle=`rgba(255,110,40,${p*.5})`;cx.beginPath();cx.ellipse(x,y+2,22,8,0,0,7);cx.fill();break}
  case 'torch':{const g=cx.createRadialGradient(x,y-40,4,x,y-40,90);const p=.32+Math.sin(now*9+d.v*9)*.06;g.addColorStop(0,`rgba(255,170,70,${p})`);g.addColorStop(1,'rgba(255,120,40,0)');cx.fillStyle=g;cx.beginPath();cx.arc(x,y-40,90,0,7);cx.fill();
    _aeShadow(cx,x,y+2,12,.4);_aeSpr(cx,'torch_'+(1+(Math.floor(now*10+d.v*8)%8)),x,y+2,2.4);break}
  case 'boxes':{_aeShadow(cx,x,y+3,18,.35);_aeSpr(cx,'boxes_stacked',x,y+4,2.4);break}
  case 'chest':{_aeShadow(cx,x,y+3,20,.35);_aeSpr(cx,'chest_closed',x,y+4,2.4);break}
  case 'mtree':{_aeShadow(cx,x,y+2,26,.4);cx.strokeStyle='#1f1a14';cx.lineCap='round';cx.lineWidth=8;cx.beginPath();cx.moveTo(x-6,y+2);cx.quadraticCurveTo(x-2,y-24,x+4,y-44);cx.stroke();
    cx.lineWidth=4;cx.beginPath();cx.moveTo(x+2,y-30);cx.quadraticCurveTo(x-18,y-40,x-26,y-56);cx.moveTo(x+4,y-40);cx.quadraticCurveTo(x+20,y-50,x+28,y-62);cx.moveTo(x-6,y+2);cx.lineTo(x-16,y+6);cx.moveTo(x-4,y);cx.lineTo(x+8,y+6);cx.stroke();
    cx.fillStyle='#2a3a22';cx.beginPath();cx.ellipse(x-4,y-56,26,13,0,0,7);cx.ellipse(x+14,y-64,18,10,0,0,7);cx.fill();
    cx.strokeStyle='rgba(90,120,70,.75)';cx.lineWidth=1.5;for(let k=0;k<7;k++){const sx=x-22+k*7;const sw=Math.sin(now*1.5+k+d.v*9)*2;cx.beginPath();cx.moveTo(sx,y-52);cx.lineTo(sx+sw,y-30-((k*7+d.v*20)%14));cx.stroke()}break}
  case 'stump':{_aeShadow(cx,x,y+2,16,.35);cx.fillStyle='#2e2418';cx.fillRect(x-10,y-14,20,15);cx.fillStyle='#4a3a26';cx.beginPath();cx.ellipse(x,y-14,10,4,0,0,7);cx.fill();cx.fillStyle='#3a5a30';cx.beginPath();cx.ellipse(x-4,y-15,5,2,0,0,7);cx.fill();break}
  case 'grave':{_aeShadow(cx,x,y+3,16,.4);cx.fillStyle='#2a2622';cx.beginPath();cx.ellipse(x,y+4,15,6,0,0,7);cx.fill();
    const t=d.v<.5;cx.fillStyle=t?'#6a6a70':'#5a5a60';cx.beginPath();cx.moveTo(x-11,y);cx.lineTo(x-11,y-22);cx.arc(x,y-22,11,Math.PI,0);cx.lineTo(x+11,y);cx.closePath();cx.fill();
    cx.fillStyle='#0003';cx.fillRect(x+3,y-30,8,30);cx.strokeStyle='#38383e';cx.lineWidth=1.5;cx.beginPath();cx.moveTo(x-6,y-20);cx.lineTo(x+6,y-20);cx.moveTo(x-4,y-14);cx.lineTo(x+4,y-14);cx.stroke();
    if(d.v>.7){cx.strokeStyle='#2a2a2e';cx.beginPath();cx.moveTo(x-2,y-33);cx.lineTo(x+2,y-24);cx.lineTo(x-1,y-16);cx.stroke()}break}
  case 'cross':{_aeShadow(cx,x,y+3,12,.4);cx.fillStyle='#5e5e66';cx.fillRect(x-3,y-38,6,38);cx.fillRect(x-11,y-30,22,6);cx.fillStyle='#0003';cx.fillRect(x+1,y-38,2,38);break}
  case 'fencep':{cx.fillStyle='#1c1c20';for(let k=-2;k<=2;k++){cx.fillRect(x+k*9-1,y-30,3,30);cx.beginPath();cx.moveTo(x+k*9-3,y-30);cx.lineTo(x+k*9+.5,y-37);cx.lineTo(x+k*9+4,y-30);cx.fill()}cx.fillRect(x-20,y-24,40,2);cx.fillRect(x-20,y-8,40,2);break}
  case 'statue':{_aeShadow(cx,x,y+4,22,.45);cx.fillStyle='#46464e';cx.fillRect(x-16,y-14,32,14);cx.fillStyle='#5a5a62';
    cx.beginPath();cx.moveTo(x-10,y-14);cx.lineTo(x-7,y-50);cx.quadraticCurveTo(x,y-62,x+7,y-50);cx.lineTo(x+10,y-14);cx.fill();
    cx.fillStyle='#4e4e56';cx.beginPath();cx.moveTo(x-7,y-46);cx.quadraticCurveTo(x-30,y-58,x-26,y-26);cx.quadraticCurveTo(x-16,y-36,x-8,y-30);cx.fill();cx.beginPath();cx.moveTo(x+7,y-46);cx.quadraticCurveTo(x+30,y-58,x+26,y-26);cx.quadraticCurveTo(x+16,y-36,x+8,y-30);cx.fill();
    cx.fillStyle='#2a2a30';cx.beginPath();cx.ellipse(x,y-50,4,5,0,0,7);cx.fill();break}
  case 'crypt':{const [hx,hy,hw,hh]=d.rect;_aeShadow(cx,hx+hw/2,hy+hh+4,hw*.6,.45);cx.fillStyle='#45434a';cx.fillRect(hx,hy+10,hw,hh-10);cx.fillStyle='#38363c';cx.fillRect(hx,hy+hh-10,hw,10);
    for(let k=0;k<4;k++){cx.fillStyle='#55535a';cx.fillRect(hx+8+k*(hw-24)/3,hy+18,8,hh-28)}
    cx.fillStyle='#120f14';cx.beginPath();cx.moveTo(hx+hw/2-16,hy+hh-10);cx.lineTo(hx+hw/2-16,hy+40);cx.arc(hx+hw/2,hy+40,16,Math.PI,0);cx.lineTo(hx+hw/2+16,hy+hh-10);cx.fill();
    cx.fillStyle='#2e2c32';cx.beginPath();cx.moveTo(hx-10,hy+14);cx.lineTo(hx+hw/2,hy-34);cx.lineTo(hx+hw+10,hy+14);cx.closePath();cx.fill();cx.fillStyle='#0004';cx.beginPath();cx.moveTo(hx+hw/2,hy-34);cx.lineTo(hx+hw+10,hy+14);cx.lineTo(hx+hw/2,hy+14);cx.fill();
    cx.fillStyle='#6a6870';cx.fillRect(hx+hw/2-2,hy-48,4,16);cx.fillRect(hx+hw/2-7,hy-44,14,4);break}
  case 'ruin':{const [rx,ry,rw]=d.rect;const h=d.h;_aeShadow(cx,rx+rw/2,ry+28,rw*.55,.45);cx.fillStyle='#4e4944';cx.beginPath();cx.moveTo(rx,ry+26);let px;cx.lineTo(rx,ry+26-h*.7);
    const n=Math.max(3,Math.round(rw/22));for(let k=1;k<=n;k++){px=rx+rw*k/n;cx.lineTo(px,ry+26-h*(.45+((Math.sin(k*3.1+d.v*20)+1)/2)*.55))}cx.lineTo(rx+rw,ry+26);cx.closePath();cx.fill();
    cx.strokeStyle='#3a3632';cx.lineWidth=1.5;for(let yy=ry+20;yy>ry+26-h;yy-=12){cx.beginPath();cx.moveTo(rx+2,yy);cx.lineTo(rx+rw-2,yy);cx.stroke()}
    cx.fillStyle='#0003';cx.fillRect(rx,ry+14,rw,12);cx.fillStyle='#38423a';cx.globalAlpha=.6;cx.fillRect(rx+rw*.2,ry+26-h*.5,rw*.15,6);cx.globalAlpha=1;break}
  case 'brazier':{const p=.32+Math.sin(now*9+d.v*9)*.06;const g=cx.createRadialGradient(x,y-34,3,x,y-34,80);g.addColorStop(0,`rgba(255,160,60,${p})`);g.addColorStop(1,'rgba(255,120,40,0)');cx.fillStyle=g;cx.beginPath();cx.arc(x,y-34,80,0,7);cx.fill();
    _aeShadow(cx,x,y+2,14,.4);cx.strokeStyle='#26201c';cx.lineWidth=3;cx.beginPath();cx.moveTo(x-10,y+2);cx.lineTo(x,y-22);cx.lineTo(x+10,y+2);cx.moveTo(x,y+2);cx.lineTo(x,y-22);cx.stroke();
    cx.fillStyle='#3a322c';cx.beginPath();cx.moveTo(x-14,y-26);cx.lineTo(x+14,y-26);cx.lineTo(x+9,y-18);cx.lineTo(x-9,y-18);cx.fill();
    const fl=Math.sin(now*14+d.v*9)*2;cx.fillStyle='#ff7a2a';cx.beginPath();cx.moveTo(x-11,y-26);cx.quadraticCurveTo(x-4,y-44-fl,x,y-50+fl);cx.quadraticCurveTo(x+5,y-42,x+11,y-26);cx.fill();cx.fillStyle='#ffd27a';cx.beginPath();cx.moveTo(x-5,y-26);cx.quadraticCurveTo(x,y-38+fl,x+5,y-26);cx.fill();break}
  case 'banner':{_aeShadow(cx,x,y+2,8,.35);cx.fillStyle='#2a221c';cx.fillRect(x-2,y-70,4,72);cx.fillRect(x-14,y-70,28,3);const w=Math.sin(now*2+d.v*9)*2;
    cx.fillStyle='#6a1a16';cx.beginPath();cx.moveTo(x-12,y-67);cx.lineTo(x+12,y-67);cx.lineTo(x+12+w,y-30);cx.lineTo(x+4+w,y-36);cx.lineTo(x-2+w,y-26);cx.lineTo(x-7+w,y-36);cx.lineTo(x-12+w,y-32);cx.closePath();cx.fill();
    cx.strokeStyle='#c8a050';cx.lineWidth=1.5;cx.beginPath();cx.moveTo(x,y-60);cx.lineTo(x,y-44);cx.moveTo(x-5,y-54);cx.lineTo(x+5,y-54);cx.stroke();break}
  case 'snowpine':{_aeShadow(cx,x,y+2,22,.25);cx.fillStyle='#3d2a1c';cx.fillRect(x-3,y-14,6,16);const s=1+d.v*.4;
    for(let k=0;k<3;k++){const w=(22-k*5)*s,top=y-(16+k*16)*s;cx.fillStyle=k%2?'#24463a':'#1c3a30';cx.beginPath();cx.moveTo(x-w,top+4);cx.lineTo(x,top-22*s);cx.lineTo(x+w,top+4);cx.fill();
      cx.fillStyle='#e6eef4';cx.beginPath();cx.moveTo(x-w*.75,top-2);cx.lineTo(x,top-22*s);cx.lineTo(x+w*.7,top-3);cx.lineTo(x+w*.3,top-6);cx.lineTo(x,top-3);cx.lineTo(x-w*.35,top-6);cx.fill()}break}
  case 'snowrock':{_aeShadow(cx,x,y+3,22,.25);cx.fillStyle=d.c2||'#465260';cx.beginPath();cx.moveTo(x-20,y+2);cx.lineTo(x-16,y-14);cx.lineTo(x-2,y-22);cx.lineTo(x+16,y-16);cx.lineTo(x+21,y);cx.closePath();cx.fill();
    cx.fillStyle='#eef4f8';cx.beginPath();cx.moveTo(x-17,y-12);cx.lineTo(x-2,y-23);cx.lineTo(x+17,y-15);cx.lineTo(x+8,y-11);cx.lineTo(x-6,y-14);cx.closePath();cx.fill();break}
  case 'icecrystal':case 'crystalR':{const ice=d.type==='icecrystal';const col=ice?['#3a6a9a','#8fd0ff','#e8f8ff','120,200,255']:['#5a0a0a','#e0302a','#ffb0a0','255,40,40'];
    const p=.6+Math.sin(now*2+d.v*9)*.25;const g=cx.createRadialGradient(x,y-16,0,x,y-16,48);g.addColorStop(0,`rgba(${col[3]},${p*.4})`);g.addColorStop(1,`rgba(${col[3]},0)`);cx.fillStyle=g;cx.beginPath();cx.arc(x,y-16,48,0,7);cx.fill();
    cx.fillStyle=col[0];cx.beginPath();cx.moveTo(x-12,y);cx.lineTo(x-6,y-38);cx.lineTo(x+1,y);cx.fill();cx.fillStyle=col[1];cx.beginPath();cx.moveTo(x-3,y);cx.lineTo(x+5,y-30);cx.lineTo(x+13,y);cx.fill();
    cx.beginPath();cx.moveTo(x-14,y);cx.lineTo(x-20,y-18);cx.lineTo(x-8,y);cx.fill();cx.fillStyle=col[2];cx.beginPath();cx.moveTo(x-6,y-38);cx.lineTo(x-4,y-16);cx.lineTo(x-9,y-14);cx.fill();break}
  case 'spike':{_aeShadow(cx,x,y+3,16,.4);for(let k=-1;k<=1;k++){const h=24+((k+1)*13+d.v*30)%22;cx.fillStyle=k?'#3a1414':'#4a1a18';cx.beginPath();cx.moveTo(x+k*9-6,y+2);cx.quadraticCurveTo(x+k*12,y-h*.6,x+k*13+3*k,y-h);cx.lineTo(x+k*9+6,y+2);cx.fill();cx.fillStyle='#c8b8a0';cx.beginPath();cx.moveTo(x+k*13+3*k,y-h);cx.lineTo(x+k*12-1,y-h+7);cx.lineTo(x+k*12+3,y-h+6);cx.fill()}break}
  case 'bonepile':{_aeShadow(cx,x,y+3,20,.4);cx.strokeStyle='#cfc2a8';cx.lineCap='round';cx.lineWidth=3;for(let k=0;k<6;k++){const a=k*1.1+d.v*6;cx.beginPath();cx.moveTo(x+Math.cos(a)*14,y-4+Math.sin(a)*5);cx.lineTo(x-Math.cos(a)*10,y-8-Math.sin(a)*6);cx.stroke()}_aeSpr(cx,'skull',x+3,y-6,1.8,{flip:d.v<.5});break}
  case 'gate':{_aeShadow(cx,x,y+4,40,.4);cx.fillStyle='#3a3640';cx.fillRect(x-36,y-70,12,72);cx.fillRect(x+24,y-70,12,72);cx.beginPath();cx.moveTo(x-38,y-66);cx.quadraticCurveTo(x,y-104,x+38,y-66);cx.lineTo(x+38,y-58);cx.quadraticCurveTo(x,y-94,x-38,y-58);cx.fill();
    const p=.5+Math.sin(now*3)*.2;const g=cx.createRadialGradient(x,y-34,4,x,y-34,34);g.addColorStop(0,`rgba(200,190,255,${p})`);g.addColorStop(1,'rgba(120,100,255,0)');cx.fillStyle=g;cx.beginPath();cx.ellipse(x,y-34,24,34,0,0,7);cx.fill();break}
  case 'throne':{_aeShadow(cx,x,y+6,60,.5);cx.fillStyle='#1a1214';cx.fillRect(x-50,y-90,100,90);cx.fillStyle='#2c1e22';cx.beginPath();cx.moveTo(x-50,y-90);cx.lineTo(x-30,y-140);cx.lineTo(x-10,y-100);cx.lineTo(x,y-160);cx.lineTo(x+10,y-100);cx.lineTo(x+30,y-140);cx.lineTo(x+50,y-90);cx.fill();cx.fillStyle='#ec7438';cx.beginPath();cx.arc(x,y-110,6,0,7);cx.fill();break}
  }
}

// ── Биомы ────────────────────────────────────────────────
// Цвета — из BIOME «Пепельного края». tall — высокие предметы (деревья, ели,
// статуи): ставятся только на клетку стены, над которой тоже стена, чтобы
// крона никогда не легла на проход и герой не «шёл по кроне». short —
// низкие (камни, пни, могилы): годятся и для кромки у прохода.
const AE_BIOME = {
  forest: {
    base: '#24391f', pal: ['#2c4a27', '#1a2c17', '#335430', '#162614'], road: ['#55452e', '#2f271b'], grass: ['#4a7a38', '#1d3319'],
    tall: [['tree', 0.5], ['pine', 0.42], ['dead', 0.08]], short: [['rock', 0.5], ['stump', 0.3], ['bush', 0.2]],
    flat: [['flower', 0.4], ['mush', 0.6]], dark: '4,10,8', da: 0.48, rock: ['#5f6560', '#3e4340'],
  },
  swamp: {
    base: '#1f2620', pal: ['#283126', '#151b16', '#2f3a2a', '#131812'], road: ['#3f3a2c', '#221f18'], grass: ['#3d4a2c', '#18200f'],
    tall: [['mtree', 0.6], ['dead', 0.4]], short: [['rock', 0.45], ['stump', 0.55]],
    flat: [['pool', 0.25], ['reed', 0.45], ['gmush', 0.15], ['bones', 0.15]], dark: '2,10,6', da: 0.6, rock: ['#4b5246', '#2c3129'], pools: 1,
  },
  grave: {
    base: '#24242a', pal: ['#2c2c33', '#18181d', '#33333b', '#1d1d22'], road: ['#47433f', '#25221f'], grass: ['#4a4d40', '#1d1f1a'],
    tall: [['dead', 0.5], ['cross', 0.25], ['grave', 0.17], ['statue', 0.08]], short: [['grave', 0.6], ['cross', 0.15], ['rock', 0.15], ['fencep', 0.1]],
    flat: [['candles', 0.18], ['bones', 0.4], ['skull', 0.25], ['grass2', 0.17]], dark: '4,4,14', da: 0.66, rock: ['#5a5a62', '#35353c'], stones: 1,
  },
  wastes: {
    base: '#3a322d', pal: ['#463c35', '#2e2724', '#514238', '#3d2f2a'], road: ['#52463d', '#2a221e'],
    tall: [['dead', 0.55], ['rock', 0.35], ['crystal', 0.1]], short: [['rock', 0.85], ['crystal', 0.15]],
    flat: [['lava', 0.12], ['bones', 0.6], ['skull', 0.28]], dark: '16,4,2', da: 0.5, rock: ['#5a4e48', '#3a322f'], cracks: 1,
  },
  fortress: {
    base: '#2f2b28', pal: ['#38332f', '#221f1c', '#403a35', '#1c1917'], road: ['#5c5650', '#2e2a26'],
    tall: [['rock', 0.35], ['dead', 0.2], ['rubblep', 0.15], ['column', 0.12], ['banner', 0.1], ['brazier', 0.08]], short: [['rock', 0.5], ['rubblep', 0.3], ['boxes', 0.2]],
    flat: [['rubble', 0.5], ['bones', 0.3], ['skull', 0.2]], dark: '8,6,6', da: 0.6, rock: ['#6a6560', '#403c38'], cobble: 1,
  },
  frozen: {
    base: '#8e9eab', pal: ['#a8b8c4', '#7a8a98', '#b8c6d0', '#6c7c8a'], road: ['#c8d4dc', '#8090a0'],
    tall: [['snowpine', 0.8], ['dead', 0.08], ['icecrystal', 0.12]], short: [['snowrock', 0.7], ['icecrystal', 0.3]],
    flat: [['snowdrift', 0.7], ['icepatch', 0.3]], dark: '4,10,28', da: 0.44, rock: ['#6a7682', '#465260'], snow: 1,
  },
  abyss: {
    base: '#241012', pal: ['#2e1416', '#170809', '#3a1a1a', '#120607'], road: ['#3e2220', '#1e0e0e'],
    tall: [['spike', 0.4], ['rock', 0.25], ['bonepile', 0.2], ['crystalR', 0.1], ['column', 0.05]], short: [['rock', 0.4], ['bonepile', 0.35], ['spike', 0.25]],
    flat: [['blood', 0.35], ['bones', 0.35], ['skull', 0.3]], dark: '18,0,2', da: 0.62, rock: ['#4a2a28', '#2a1414'], cracks: 2,
  },
};
const _AE_DECO_SCALE = 0.8;   // предметы «Пепельного края» под рост героев Liberty
const _AE_FLOWER = ['#e9d36a', '#d8d0f0', '#e07a9a'];
const _AE_GLOW = new Set(['brazier', 'crystal', 'crystalR', 'icecrystal']);

// Темы для js/zones.js: сама картинка рисуется aeDrawGround ниже, тема
// несёт лишь вуаль биома и флаги. wall: null — каменного «обрыва» у стены
// нет (как у деревьев Мира). noDepth — затемнение толщи стены здесь своё,
// под декором, а не поверх него квадратами.
Object.keys(AE_BIOME).forEach(k => {
  const B = AE_BIOME[k];
  _ZONE_ST['ae_' + k] = {
    ae: k, wall: null, noDepth: true,
    // Вуаль слабее, чем у «Пепельного края»: там её прорезает свет вокруг
    // героя, здесь она запечена в пол ровным слоем.
    overlay: `rgba(${B.dark},${(B.da * 0.3).toFixed(3)})`,
    floor() {}, wallTile() {}, deco() {},
  };
});

function _aeMix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
}

function _aePick(list, h) {
  let sum = 0; for (const it of list) sum += it[1];
  let t = h * sum;
  for (const it of list) { t -= it[1]; if (t <= 0) return it[0]; }
  return list[0][0];
}

let _aeRoomFor = null, _aeRoomSet = null;
function _aeInRoom(tx, ty) {
  const d = dungeon;
  if (_aeRoomFor !== d) {
    _aeRoomFor = d; _aeRoomSet = new Set();
    for (const r of (d.rooms || [])) {
      const s = r.size || 0;
      for (let y = r.y; y < r.y + s; y++) for (let x = r.x; x < r.x + s; x++) _aeRoomSet.add(y * 100000 + x);
    }
  }
  return _aeRoomSet.has(ty * 100000 + tx);
}
function _aeFloor(tx, ty) {
  return tx >= 0 && ty >= 0 && tx < dungeon.w && ty < dungeon.h && dungeon.grid[ty][tx] === FLOOR;
}
// Дорога — проходы между комнатами; комнаты — поляны того же биома.
function _aeRoad(tx, ty) { return _aeFloor(tx, ty) && !_aeInRoom(tx, ty); }
// 0 — проход, 1..3 — сколько клеток до ближайшего прохода (3 — «дальше»).
function _aeDepth(tx, ty) {
  if (_aeFloor(tx, ty)) return 0;
  for (let r = 1; r <= 2; r++) {
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) if (_aeFloor(tx + ox, ty + oy)) return r;
  }
  return 3;
}

function _aeTileGround(c, B, x, y, tx, ty) {
  const T = TILE, h = (s) => _zh(tx, ty, s);
  // Пятна палитры — в пределах своей клетки и кольца соседей, чтобы чанк
  // дорисовывал то же, что сосед.
  for (let k = 0; k < 2; k++) {
    c.globalAlpha = 0.08 + h(200 + k) * 0.14; c.fillStyle = B.pal[(tx + ty + k) & 3];
    c.beginPath(); c.arc(x + h(202 + k) * T, y + h(204 + k) * T, 12 + h(206 + k) * 24, 0, 7); c.fill();
  }
  c.globalAlpha = 1;
  if (B.grass) {
    c.lineWidth = 1;
    for (let k = 0; k < 8; k++) {
      const gx = x + h(210 + k) * T, gy = y + h(220 + k) * T;
      c.strokeStyle = h(230 + k) < 0.5 ? B.grass[0] : B.grass[1]; c.globalAlpha = 0.2 + h(240 + k) * 0.35;
      c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + (h(250 + k) - 0.5) * 4, gy - 3 - h(260 + k) * 4); c.stroke();
    }
    c.globalAlpha = 1;
  }
  if (B.cracks && h(270) < 0.14) {
    const hot = h(271) < 0.3, col = B.cracks === 2 ? '#d0281a' : '#b8481f';
    c.lineCap = 'round'; c.strokeStyle = hot ? col : '#140c0b'; c.globalAlpha = hot ? 0.6 : 0.7; c.lineWidth = 1 + h(272) * 1.5;
    let px = x + h(273) * T, py = y + h(274) * T;
    c.beginPath(); c.moveTo(px, py);
    for (let k = 0; k < 4; k++) { px += (h(275 + k) - 0.5) * 16; py += (h(279 + k) - 0.5) * 16; c.lineTo(px, py); }
    c.stroke(); c.globalAlpha = 1; c.lineCap = 'butt';
  }
  if (B.cracks) for (let k = 0; k < 2; k++) { c.globalAlpha = 0.2 + h(285 + k) * 0.3; c.fillStyle = h(287 + k) < 0.5 ? B.pal[2] : '#110a0a'; c.fillRect(x + h(289 + k) * T, y + h(291 + k) * T, 2, 2); }
  if (B.pools && h(300) < 0.05) {
    const w = 18 + h(301) * 18;
    c.globalAlpha = 0.55; c.fillStyle = '#0d1a17'; c.beginPath(); c.ellipse(x + 20, y + 20, w, w * 0.5, 0, 0, 7); c.fill();
    c.globalAlpha = 0.25; c.strokeStyle = '#4a6a50'; c.lineWidth = 2; c.stroke(); c.globalAlpha = 1;
  }
  if (B.stones && h(305) < 0.12) {
    c.globalAlpha = 0.35; c.fillStyle = '#3e3a36';
    for (let k = 0; k < 4; k++) c.fillRect(x + h(306 + k) * 26, y + h(310 + k) * 30, 10 + h(314 + k) * 8, 6 + h(318 + k) * 4);
    c.globalAlpha = 1;
  }
  if (B.snow) {
    if (h(320) < 0.06) {
      const w = 14 + h(321) * 22, ex = x + 20, ey = y + 20;
      const gg = c.createLinearGradient(ex - w, ey, ex + w, ey);
      gg.addColorStop(0, 'rgba(170,220,255,.15)'); gg.addColorStop(0.5, 'rgba(220,245,255,.45)'); gg.addColorStop(1, 'rgba(170,220,255,.15)');
      c.fillStyle = gg; c.beginPath(); c.ellipse(ex, ey, w, w * 0.35, (h(322) - 0.5) * 0.6, 0, 7); c.fill();
    }
    for (let k = 0; k < 3; k++) { c.globalAlpha = 0.3 + h(323 + k) * 0.4; c.fillStyle = h(326 + k) < 0.7 ? '#e8f0f6' : '#6a7a8a'; c.fillRect(x + h(329 + k) * T, y + h(332 + k) * T, 2, 2); }
    c.globalAlpha = 1;
  }
  if (B.cracks === 2 && h(340) < 0.04) {
    const w = 14 + h(341) * 20; c.globalAlpha = 0.5; c.fillStyle = '#3a0606';
    c.beginPath(); c.ellipse(x + 20, y + 20, w, w * 0.5, 0, 0, 7); c.fill(); c.globalAlpha = 1;
  }
}

// Дорога: полоса цвета B.road[0] с тёмной кромкой B.road[1] там, где
// дальше не дорога, и крапинкой, как у «Пепельного края».
function _aeTileRoad(c, B, x, y, tx, ty) {
  const T = TILE, h = (s) => _zh(tx, ty, s);
  c.fillStyle = B.road[0]; c.fillRect(x, y, T, T);
  const E = 6;
  c.fillStyle = B.road[1];
  if (!_aeRoad(tx - 1, ty) && !_aeInRoom(tx - 1, ty)) c.fillRect(x, y, E, T);
  if (!_aeRoad(tx + 1, ty) && !_aeInRoom(tx + 1, ty)) c.fillRect(x + T - E, y, E, T);
  if (!_aeRoad(tx, ty - 1) && !_aeInRoom(tx, ty - 1)) c.fillRect(x, y, T, E);
  if (!_aeRoad(tx, ty + 1) && !_aeInRoom(tx, ty + 1)) c.fillRect(x, y + T - E, T, E);
  for (let k = 0; k < 6; k++) {
    c.globalAlpha = 0.35; c.fillStyle = h(350 + k) < 0.5 ? B.pal[2] : B.road[1];
    c.fillRect(x + 4 + h(360 + k) * (T - 8), y + 4 + h(370 + k) * (T - 8), 2, 2);
  }
  c.globalAlpha = 1;
  if (B.cobble) {
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      if (h(380 + r * 3 + k) < 0.3) continue;
      c.globalAlpha = 0.35; c.fillStyle = h(390 + r * 3 + k) < 0.5 ? '#6a645c' : '#4a4540';
      c.fillRect(x + 2 + k * 13 + (r & 1) * 5, y + 2 + r * 13, 11, 10);
    }
    c.globalAlpha = 1;
  }
}

function _aeObject(c, type, B, x, y, v) {
  c.save(); c.translate(x, y); c.scale(_AE_DECO_SCALE, _AE_DECO_SCALE);
  if (type === 'bush') {
    _aeShadow(c, 0, 2, 18, 0.35);
    c.fillStyle = '#1f3d1e'; c.beginPath(); c.arc(-8, -8, 11, 0, 7); c.arc(8, -9, 10, 0, 7); c.arc(0, -16, 12, 0, 7); c.fill();
    c.fillStyle = '#2a4d27'; c.beginPath(); c.arc(-3, -15, 7, 0, 7); c.fill();
  } else if (type === 'rubblep') {
    _aeShadow(c, 0, 2, 18, 0.35);
    c.fillStyle = '#4e4944'; for (let k = 0; k < 5; k++) c.fillRect(Math.sin(k * 2.3 + v * 9) * 12 - 5, -6 + Math.cos(k * 1.7 + v * 7) * 6 - 4, 10, 8);
  } else {
    _aeDecoDraw(c, { type, x: 0, y: 0, v, c1: B.rock[0], c2: B.rock[1] });
  }
  c.restore();
}

// Вся земля зоны «Пепельного края» в прямоугольнике клеток чанка (с кольцом
// соседей). Три прохода: основа, детали клетки, предметы на стенах — в
// порядке строк, так что нижний предмет ложится поверх верхнего.
function aeDrawGround(c, Z, tx0, ty0, tx1, ty1) {
  const T = TILE;
  // Основа — без дрожания границы, которое у тем по клеткам: у биомов разный
  // тон земли, и клеточная граница читалась шахматкой. Здесь тон плавно
  // перетекает из одного в другой на полосе в пятую часть коридора.
  const A0 = AE_BIOME[_ZONE_ST[Z.stages[0]].ae] || AE_BIOME.forest;
  const A1 = AE_BIOME[_ZONE_ST[Z.stages[1]].ae] || A0;
  for (let tx = tx0; tx <= tx1; tx++) {
    let base = A0.base;
    if (A1 !== A0) {
      const t = (tx - Z.x0) / Math.max(1, Z.x1 - Z.x0);
      base = _aeMix(A0.base, A1.base, Math.max(0, Math.min(1, (t - 0.45) / 0.2)));
    }
    c.fillStyle = base; c.fillRect(tx * T, ty0 * T, T, (ty1 - ty0 + 1) * T);
  }
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const B = AE_BIOME[_zoneStage(Z, tx, ty).ae] || AE_BIOME.forest;
    const x = tx * T, y = ty * T;
    if (_aeRoad(tx, ty)) _aeTileRoad(c, B, x, y, tx, ty);
    else _aeTileGround(c, B, x, y, tx, ty);
  }
  // Толща стены — мягкой тенью по земле, до предметов: так деревья в глубине
  // не превращаются в чёрные квадраты.
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const d = _aeDepth(tx, ty);
    if (!d) continue;
    c.fillStyle = `rgba(0,0,0,${[0, 0.18, 0.32, 0.45][d]})`; c.fillRect(tx * T, ty * T, T, T);
  }
  // Мелочь на полянах и у дороги — под предметами стен.
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (!_aeFloor(tx, ty)) continue;
    const road = !_aeInRoom(tx, ty);
    const h1 = _zh(tx, ty, 400);
    if (h1 > (road ? 0.04 : 0.14)) continue;
    const B = AE_BIOME[_zoneStage(Z, tx, ty).ae] || AE_BIOME.forest;
    const type = _aePick(B.flat, _zh(tx, ty, 401));
    if (road && (type === 'pool' || type === 'lava' || type === 'blood')) continue;
    _aeFlatDraw(c, { type, x: tx * T + 8 + _zh(tx, ty, 402) * 24, y: ty * T + 10 + _zh(tx, ty, 403) * 24,
      v: _zh(tx, ty, 404), r: 10 + _zh(tx, ty, 405) * 12, c: _AE_FLOWER[(tx + ty) % 3] });
  }
  // Предметы на стенах. Строки ниже чанка тоже — их высокие предметы
  // заходят в чанк сверху; столбцы на одну шире — кроны свисают вбок.
  const W = dungeon.w, H = dungeon.h;
  for (let ty = ty0; ty <= Math.min(H - 1, ty1 + 2); ty++) {
    for (let tx = Math.max(0, tx0 - 1); tx <= Math.min(W - 1, tx1 + 1); tx++) {
      if (_aeFloor(tx, ty)) continue;
      const B = AE_BIOME[_zoneStage(Z, tx, ty).ae] || AE_BIOME.forest;
      const tall = ty > 0 && !_aeFloor(tx, ty - 1) && _zh(tx, ty, 410) < 0.85;
      // Глубоко в массиве — не каждая клетка: сплошной частокол одинаковых
      // крон читается узором, а не лесом.
      const depth = _aeDepth(tx, ty);
      if (depth === 3 && _zh(tx, ty, 411) < (B.grass ? 0.25 : 0.5)) continue;
      let type = _aePick(tall ? B.tall : B.short, _zh(tx, ty, 412));
      // Светящееся (жаровня, кристаллы) — только у самого прохода, как
      // факел у дороги: в толще массива оно заливало экран светом.
      if (_AE_GLOW.has(type) && depth !== 1) type = tall ? 'rock' : B.short[0][0];
      _aeObject(c, type, B, tx * T + 20 + (_zh(tx, ty, 413) - 0.5) * 16, ty * T + T - 4 - _zh(tx, ty, 414) * 6, _zh(tx, ty, 415));
    }
  }
}

// ── Монстры ──────────────────────────────────────────────
// Вид Liberty → спрайт «Пепельного края» из атласа. fly — висит над тенью
// и покачивается в воздухе. Неизвестные виды (вышки, особые режимы)
// остаются со своими листами анимаций.
const AE_MONSTER = {
  rat_guard: ['monster_goblin'], rat_warrior: ['monster_wogol'],
  slime_guard: ['monster_elemental_goo_small'], slime_warrior: ['monster_elemental_goo'],
  imp_guard: ['monster_imp', 1], imp_warrior: ['monster_bies'], imp_boss: ['monster_chort'],
  zombie_guard: ['monster_zombie'], zombie_warrior: ['monster_zombie_green'],
  lizardman_guard: ['monster_orc_masked'], lizardman_warrior: ['monster_rokita'],
  orc_guard: ['monster_orc'], orc_warrior: ['monster_orc_armored'], orc_boss: ['monster_orc_veteran'],
  plant_guard: ['monster_elemental_plant_small'], plant_warrior: ['monster_elemental_plant'],
  vampire_guard: ['monster_bat', 1], vampire_warrior: ['monster_necromancer'],
  beholder_guard: ['monster_elemental_air', 1], beholder_warrior: ['monster_elemental_water'], beholder_boss: ['monster_tentackle'],
  ent_guard: ['monster_elemental_earth'], ent_warrior: ['monster_ogre'],
  demon_guard: ['monster_demonolog'], demon_warrior: ['monster_dark_knight'], demon_boss: ['monster_demon'],
  demon_event_boss: ['monster_demon'], race10_boss: ['monster_demon'],
  dungeon_lich_skeleton: ['monster_skelet'], dungeon_lich_blue: ['monster_necromancer'], dungeon_lich_commander: ['monster_dark_knight'],
};
