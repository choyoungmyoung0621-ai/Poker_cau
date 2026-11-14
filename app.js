const $ = s=>document.querySelector(s);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STAGES={lobby:'대기실',preflop:'프리플랍',flop:'플랍',turn:'턴',river:'리버',showdown:'쇼다운'};
const SUITS={S:'♠',H:'♥',D:'♦',C:'♣'};
const SESSION_KEY='felt.session.v1',NAME_KEY='felt.nickname.v1';
let session=null,socket=null,state=null,reconnectHandle=null,reconnectCount=0,clockSkew=0,lastPing=0,lastChatCount=-1,toastHandle=null;

function toast(message){const box=$('#toast');box.textContent=message;box.classList.remove('hidden');clearTimeout(toastHandle);toastHandle=setTimeout(()=>box.classList.add('hidden'),4200);}
const fmt=n=>Number(n||0).toLocaleString('ko-KR');
function cardHTML(c){
  if(c==='back') return '<div class="poker-card back"></div>';
  if(!c) return '<div class="poker-card placeholder"></div>';
  const r=Number(c.slice(0,-1)),s=c.at(-1);
  return `<div class="poker-card ${s==='H'||s==='D'?'red':''}"><span>${escapeHTML(({11:'J',12:'Q',13:'K',14:'A'})[r]||r)}</span><span class="suit">${SUITS[s]||'?'}</span></div>`;
}
function setConnected(ok){$('#connection-status').textContent=ok?'서버 연결됨':'연결 중…';$('#online-dot').style.background=ok?'#3ee49b':'#d89e5b';}
function showLanding(){
  $('#game').classList.add('hidden');$('#landing').classList.remove('hidden');
  $('#create-name').value=localStorage.getItem(NAME_KEY)||'';
  $('#join-name').value=localStorage.getItem(NAME_KEY)||'';
  const code=new URLSearchParams(location.search).get('room');if(code)$('#join-code').value=code.toUpperCase();
}
function showGame(){ $('#landing').classList.add('hidden');$('#game').classList.remove('hidden');$('#room-code').textContent=session.code;setConnected(false); }
function remember(s){session=s;localStorage.setItem(SESSION_KEY,JSON.stringify(s));localStorage.setItem(NAME_KEY,s.member.name);}
async function requestAPI(path,body){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:'서버 응답이 올바르지 않아요.'}));
  if(!response.ok)throw new Error(data.error||'서버 요청에 실패했어요.');
  return data;
}
async function enter(mode){
  const name=(mode==='create'?$('#create-name'):$('#join-name')).value.trim();
  const code=$('#join-code').value.trim().toUpperCase();
  if(name.length<2){toast('닉네임을 2자 이상 입력해 주세요.');return;}
  if(mode==='join'&&!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){toast('정확한 6자리 방 코드를 입력해 주세요.');return;}
  const button=mode==='create'?$('#create-button'):$('#join-button');button.disabled=true;
  try{
    const data=await requestAPI(mode==='create'?'/api/rooms':`/api/rooms/${code}/join`,{name});
    remember({code:data.code,member:data.member});
    history.replaceState(null,'',`/?room=${encodeURIComponent(data.code)}`);
    showGame();connect();
  }catch(e){toast(e.message||'접속할 수 없어요.');}
  finally{button.disabled=false;}
}
function connect(){
  if(!session)return;
  if(socket){socket.onclose=null;socket.close();}
  clearTimeout(reconnectHandle);
  const scheme=location.protocol==='https:'?'wss:':'ws:';
  const endpoint=`${scheme}//${location.host}/api/ws/${session.code}?pid=${encodeURIComponent(session.member.id)}&token=${encodeURIComponent(session.member.auth)}`;
  const ws=new WebSocket(endpoint);socket=ws;setConnected(false);
  ws.onopen=()=>{if(ws!==socket)return;reconnectCount=0;setConnected(true);ws.send('ping');lastPing=performance.now();};
  ws.onmessage=event=>{
    if(ws!==socket)return;
    if(event.data==='pong'){$('#latency').textContent=`PING ${Math.round(performance.now()-lastPing)}ms`;return;}
    let data;try{data=JSON.parse(event.data);}catch{return;}
    if(data.type==='error'){toast(data.error);return;}
    if(data.type==='left')return;
    if(data.type==='state'){
      state=data;clockSkew=data.now-Date.now();render();
    }
  };
  ws.onerror=()=>{};
  ws.onclose=e=>{
    if(ws!==socket||!session)return;
    setConnected(false);
    if(e.code===4000){toast('다른 창에서 같은 좌석으로 접속했어요.');return;}
    if(e.code===1008||e.code===4001){toast('입장 정보가 만료되었어요. 다시 입장해 주세요.');return;}
    const delay=Math.min(12000,700*(2**Math.min(reconnectCount++,4)));
    reconnectHandle=setTimeout(connect,delay);
  };
}
function send(payload){
  if(!socket||socket.readyState!==1){toast('서버에 다시 연결하는 중이에요.');return false;}
  socket.send(JSON.stringify(payload));return true;
}
function doAction(action,to){send({type:'act',action,to,opId:crypto.randomUUID().replace(/-/g,'')});}
function render(){
  if(!state)return;
  $('#room-code').textContent=state.code;
  $('#stage-name').textContent=STAGES[state.stage]||state.stage;
  $('#hand-number').textContent=`HAND #${state.hand}`;
  $('#pot-value').innerHTML=`${fmt(state.pot)} <span>CHIPS</span>`;
  $('#community').innerHTML=Array.from({length:5},(_,i)=>cardHTML(state.community[i])).join('');
  const hint=$('#table-hint');
  hint.textContent=state.stage==='lobby'?'친구들을 초대하고 게임을 시작해요':state.stage==='showdown'?'이번 핸드가 종료됐어요':state.turnId?`${state.players.find(p=>p.id===state.turnId)?.name||'플레이어'}의 차례`:'공용 카드를 공개하는 중…';
  renderSeats();renderRoster();renderActions();renderResults();renderChat();tick();
}
function seatCards(p){
  if(!p.inHand)return '';
  let cards=p.showCards||((p.id===state.me.id)?state.me.hole:null);
  if(!cards&&state.stage==='showdown'&&p.folded)return '<div class="seat-cards"><span class="seat-tag">폴드</span></div>';
  return `<div class="seat-cards">${cards?.map(cardHTML).join('')||(cardHTML('back')+cardHTML('back'))}</div>`;
}
function renderSeats(){
  const root=$('#seats');root.innerHTML='';
  const all=[...state.players].sort((a,b)=>a.seat-b.seat);
  const start=Math.max(0,all.findIndex(p=>p.id===state.me.id));
  const ordered=[...all.slice(start),...all.slice(0,start)];
  const n=ordered.length;
  ordered.forEach((p,i)=>{
    const theta=Math.PI/2+Math.PI*2*i/n;
    const x=50+Math.cos(theta)*43,y=50+Math.sin(theta)*40;
    const cls=['seat',p.id===state.me.id?'me':'',p.id===state.turnId?'current':'',!p.online?'offline':'',p.folded&&p.inHand?'folded':''].filter(Boolean).join(' ');
    const seat=el('div',cls);seat.style.left=`${x}%`;seat.style.top=`${y}%`;
    const dealer=p.inHand&&p.seat===state.dealerSeat?'<div class="dealer-mark">D</div>':'';
    const label=p.id===state.me.id?' (나)':'';
    const status=p.inHand?(p.folded?'FOLD':p.allIn?'ALL-IN':p.bet?'BET '+fmt(p.bet):'플레이 중'):'다음 판 대기';
    seat.innerHTML=`${dealer}<div class="seat-name">${escapeHTML(p.name+label)}</div><div class="seat-chips">◈ ${fmt(p.chips)}</div><div class="seat-bet">${escapeHTML(status)}</div>${seatCards(p)}${p.id===state.turnId?'<div class="timer-pill" data-turn-timer>25s</div>':''}`;
    root.append(seat);
  });
}
function renderRoster(){
  $('#player-count').textContent=`${state.players.length}/8`;
  const root=$('#roster');root.innerHTML='';
  state.players.forEach(p=>{
    const row=el('div','roster-item');
    const avatar=el('div','roster-avatar',p.name[0]?.toUpperCase()||'?');
    const name=el('div','roster-name',p.name+(p.id===state.hostId?' ♛':''));
    const status=el('div','roster-status',p.online?'● 접속':'○ 오프라인');
    row.append(avatar,name,status);
    if(!p.online && state.hostId===state.me.id && ['lobby','showdown'].includes(state.stage) && p.id!==state.me.id){
      const button=el('button','icon-btn','×');button.title='오프라인 좌석 비우기';button.style.cssText='width:23px;height:23px;font-size:15px';
      button.onclick=()=>{if(confirm(`${p.name}님의 오프라인 좌석을 비울까요?`)) send({type:'kick',playerId:p.id});};
      row.append(button);
    }
    root.append(row);
  });
}
function renderActions(){
  const root=$('#action-panel');root.innerHTML='';
  if(['lobby','showdown'].includes(state.stage)){
    if(state.players.find(p=>p.id===state.me.id)?.chips===0){
      const rebuy=el('button','btn btn-secondary','◈ 무료 가상 칩 1,000개 다시 받기');
      rebuy.onclick=()=>send({type:'rebuy'});root.append(rebuy);return;
    }
    if(state.hostId===state.me.id){
      const btn=el('button','btn btn-primary',state.stage==='lobby'?'게임 시작하기 ↗':'다음 핸드 시작 ↗');
      btn.style.minWidth='230px';btn.disabled=state.players.filter(p=>p.online&&p.chips>0).length<2;
      btn.onclick=()=>send({type:'start'});root.append(btn);
      if(btn.disabled)root.append(el('p',null,'접속한 플레이어가 2명 이상 있어야 시작할 수 있어요.'));
    }else root.append(el('p',null,'방장이 게임을 시작하면 자동으로 참여해요.'));
    return;
  }
  if(!state.me.legal){
    const my=state.players.find(p=>p.id===state.me.id);
    let message='다른 플레이어의 차례예요.';
    if(!my?.inHand)message='다음 핸드부터 게임에 참여할 수 있어요.';
    else if(my.folded)message='폴드했어요. 다음 핸드를 기다려 주세요.';
    else if(my.allIn)message='올인! 쇼다운을 기다려 주세요.';
    root.append(el('p',null,message));return;
  }
  const info=state.me.legal;
  const row=el('div','action-row');
  const fold=el('button','btn fold-btn','폴드');fold.onclick=()=>doAction('fold');
  const call=el('button','btn call-btn',info.toCall===0?'체크':`콜 ${fmt(info.callAmount)}`);
  call.onclick=()=>doAction(info.toCall===0?'check':'call');
  row.append(fold,call);
  if(info.canRaise){
    const box=el('div','bet-box');
    const min=Math.min(info.minTo,info.maxTo),max=info.maxTo;
    const slider=el('input');slider.type='range';slider.min=String(min);slider.max=String(max);slider.step='1';slider.value=String(min);slider.title='레이즈 이후 이번 라운드 총 베팅 금액';
    const number=el('input','bet-number');number.type='number';number.min=String(min);number.max=String(max);number.value=String(min);
    slider.oninput=()=>number.value=slider.value;
    number.oninput=()=>{const v=Number(number.value);if(Number.isFinite(v))slider.value=String(Math.min(max,Math.max(min,v)));};
    number.onblur=()=>{number.value=slider.value;};
    box.append(slider,number);
    const raise=el('button','btn raise-btn',min===max?'올인':'레이즈');
    raise.onclick=()=>{const v=Number(number.value);if(!Number.isSafeInteger(v)||v<min||v>max){toast(`베팅 금액은 ${fmt(min)}~${fmt(max)} 사이여야 해요.`);return;}doAction('raise',v);};
    row.append(box,raise);
  }
  root.append(row);
}
function renderResults(){
  const root=$('#results');root.innerHTML='';
  if(state.stage!=='showdown'||!state.result){root.classList.add('hidden');return;}
  root.classList.remove('hidden');
  root.append(el('div','section-num','HAND RESULT'));
  root.append(el('h3',null,`🏆 ${state.result.payouts.map(p=>p.name).join(' · ')||'승자'} 승리`));
  for(const p of state.result.payouts)root.append(el('p',null,`${p.name} +${fmt(p.amount)}칩`));
  for(const [id,hand] of Object.entries(state.result.hands||{})){
    const name=state.players.find(p=>p.id===id)?.name||'플레이어';
    root.append(el('p',null,`${name} — ${hand.label}`));
  }
  if(state.proof){
    const button=el('button',null,'♧ 카드 셔플 공정성 검증');button.onclick=verifyFairness;
    root.append(button);
  }
}
function renderChat(){
  if(!state.chat)return;
  const root=$('#chat-messages');
  if(lastChatCount===state.chat.length && root.dataset.lastId===String(state.chat.at(-1)?.id||''))return;
  const nearBottom=root.scrollTop+root.clientHeight>=root.scrollHeight-35;
  root.innerHTML='';
  if(!state.chat.length)root.append(el('div','chat-empty','아직 메시지가 없어요.'));
  for(const m of state.chat){const line=el('div','chat-message');line.append(el('b',null,m.name),el('span',null,m.text));root.append(line);}
  lastChatCount=state.chat.length;root.dataset.lastId=state.chat.at(-1)?.id||'';
  if(nearBottom||state.chat.length===1)root.scrollTop=root.scrollHeight;
}
function tick(){
  if(!state||!state.turnId||!state.deadline)return;
  const sec=Math.max(0,Math.ceil((state.deadline-(Date.now()+clockSkew))/1000));
  document.querySelectorAll('[data-turn-timer]').forEach(x=>x.textContent=`${sec}s`);
}
async function verifyFairness(){
  if(!state.proof)return;
  try{
    const f=state.proof, deck=f.deck;
    if(deck.length!==52||new Set(deck).size!==52)throw Error('덱에 중복 카드가 있어요.');
    const buffer=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${f.nonce}:${deck.join(',')}`));
    const hash=[...new Uint8Array(buffer)].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==state.commit||hash!==f.commit)throw Error('셔플 해시가 다릅니다.');
    const holePositions=f.dealtPositions[state.me.id];
    if(holePositions&&state.me.hole.some((c,i)=>deck[holePositions[i]]!==c))throw Error('내 카드 배분이 셔플 기록과 다릅니다.');
    if(state.community.some((c,i)=>deck[f.communityIndices[i]]!==c))throw Error('공용 카드가 셔플 기록과 다릅니다.');
    toast('✅ 카드 52장과 셔플 해시, 내 카드·공용 카드가 일치해요.');
  }catch(e){toast('❌ 검증 실패: '+e.message);}
}
$('#create-form').onsubmit=e=>{e.preventDefault();enter('create');};
$('#join-form').onsubmit=e=>{e.preventDefault();enter('join');};
$('#join-code').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,'').slice(0,6);
$('#invite-btn').onclick=async()=>{if(!session)return;const url=`${location.origin}/?room=${session.code}`;try{await navigator.clipboard.writeText(url);toast('초대 링크를 복사했어요.');}catch{toast('초대 주소: '+url);}};
$('#exit-btn').onclick=()=>{
  if(!confirm('방에서 나갈까요? 게임 중에는 자리가 남아 있고 제한 시간이 지나면 자동으로 폴드돼요.'))return;
  if(['lobby','showdown'].includes(state?.stage))send({type:'leave'});
  const old=socket;socket=null;if(old){old.onclose=null;setTimeout(()=>old.close(),150);}
  clearTimeout(reconnectHandle);session=null;state=null;lastChatCount=-1;localStorage.removeItem(SESSION_KEY);
  history.replaceState(null,'','/');showLanding();
};
$('#chat-form').onsubmit=e=>{e.preventDefault();const input=$('#chat-input');const text=input.value.trim();if(!text)return;if(send({type:'chat',text}))input.value='';};
setInterval(()=>{if(socket?.readyState===1){lastPing=performance.now();socket.send('ping');}},10000);
setInterval(tick,300);
(function init(){
  const params=new URLSearchParams(location.search),room=(params.get('room')||'').toUpperCase();
  let existing;try{existing=JSON.parse(localStorage.getItem(SESSION_KEY));}catch{}
  if(existing?.code && (!room||room===existing.code) && existing.member?.auth){session=existing;showGame();connect();}
  else showLanding();
})();
