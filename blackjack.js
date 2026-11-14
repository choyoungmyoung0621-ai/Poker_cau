const $=selector=>document.querySelector(selector);
const make=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
const STORAGE='felt.blackjack.session.v1',NAME='felt.nickname.v1';
const STAGES={lobby:'대기실',playing:'게임 진행 중',result:'라운드 종료'};
const SUITS={S:'♠',H:'♥',D:'♦',C:'♣'};
const fmt=n=>Number(n||0).toLocaleString('ko-KR');
let session=null,state=null,ws=null,tries=0,clockOffset=0,pingSent=0,toastTimer=0,reconnectTimer=0,pendingAction=false;
let chatLastId='';
function toast(message){const e=$('#toast');e.textContent=message;e.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.add('hidden'),4300);}
function showLanding(){
  $('#game').classList.add('hidden');$('#landing').classList.remove('hidden');
  $('#create-name').value=localStorage.getItem(NAME)||'';
  $('#join-name').value=localStorage.getItem(NAME)||'';
  const urlRoom=new URLSearchParams(location.search).get('room');
  if(urlRoom)$('#join-code').value=urlRoom.toUpperCase();
}
function showGame(){
  $('#landing').classList.add('hidden');$('#game').classList.remove('hidden');
  $('#room-code').textContent=session.code;connection(false);
}
function connection(isOn){$('#connection-status').textContent=isOn?'서버 연결됨':'서버 연결 중…';$('#online-dot').style.background=isOn?'#3ee49b':'#dda767';}
function remember(value){session=value;localStorage.setItem(STORAGE,JSON.stringify(value));localStorage.setItem(NAME,value.member.name);}
async function request(path,data){
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const body=await response.json().catch(()=>({error:'서버 응답이 올바르지 않아요.'}));
  if(!response.ok)throw Error(body.error||'요청 실패');return body;
}
async function enter(how){
  const name=(how==='create'?$('#create-name'):$('#join-name')).value.trim();
  const code=$('#join-code').value.trim().toUpperCase();
  if(name.length<2){toast('닉네임을 2자 이상 입력해 주세요.');return;}
  if(how==='join'&&!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){toast('6자리 방 코드를 확인해 주세요.');return;}
  const button=how==='create'?$('#create-button'):$('#join-button');button.disabled=true;
  try{
    const data=await request(how==='create'?'/api/rooms':`/api/rooms/${code}/join`,{name,mode:'blackjack'});
    remember({code:data.code,member:data.member});
    history.replaceState(null,'',`/blackjack.html?room=${encodeURIComponent(data.code)}`);
    showGame();connect();
  }catch(e){toast(e.message);}finally{button.disabled=false;}
}
function connect(){
  if(!session)return;
  if(ws){ws.onclose=null;ws.close();}
  clearTimeout(reconnectTimer);
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const url=`${proto}//${location.host}/api/ws/${session.code}?pid=${encodeURIComponent(session.member.id)}&token=${encodeURIComponent(session.member.auth)}`;
  const current=new WebSocket(url);ws=current;connection(false);
  current.onopen=()=>{if(current!==ws)return;tries=0;connection(true);pingSent=performance.now();current.send('ping');};
  current.onmessage=e=>{
    if(current!==ws)return;
    if(e.data==='pong'){$('#latency').textContent=`PING ${Math.round(performance.now()-pingSent)}ms`;return;}
    let payload;try{payload=JSON.parse(e.data);}catch{return;}
    if(payload.type==='error'){pendingAction=false;toast(payload.error);renderActions();return;}
    if(payload.type==='state'&&payload.mode==='blackjack'){
      state=payload;clockOffset=payload.now-Date.now();pendingAction=false;render();
    }
  };
  current.onerror=()=>{};
  current.onclose=e=>{
    if(current!==ws||!session)return;
    connection(false);
    if(e.code===4000){toast('다른 브라우저에서 같은 좌석으로 접속했어요.');return;}
    const delay=Math.min(12000,700*2**Math.min(tries++,4));
    reconnectTimer=setTimeout(connect,delay);
  };
}
function send(payload){
  if(!ws||ws.readyState!==1){toast('서버에 연결 중이에요.');return false;}
  ws.send(JSON.stringify(payload));return true;
}
function command(action){
  if(pendingAction)return;
  if(send({type:'act',action,hand:state.hand,handIndex:state.handIndex,opId:crypto.randomUUID().replace(/-/g,'')})){
    pendingAction=true;renderActions();
  }
}
function card(card){
  const item=make('div','poker-card');
  if(card==='back'){item.classList.add('back');return item;}
  if(!card||!/^(?:[2-9]|1[0-4])[SHDC]$/.test(card)){item.classList.add('placeholder');return item;}
  const rank=Number(card.slice(0,-1)),suit=card.at(-1);
  if(suit==='D'||suit==='H')item.classList.add('red');
  item.append(make('span',null,({11:'J',12:'Q',13:'K',14:'A'})[rank]||String(rank)),make('span','suit',SUITS[suit]));
  return item;
}
function cards(container,list){container.replaceChildren(...list.map(card));}
function timer(){
  if(!state?.deadline)return;
  const seconds=Math.max(0,Math.ceil((state.deadline-(Date.now()+clockOffset))/1000));
  document.querySelectorAll('[data-bj-timer]').forEach(el=>el.textContent=`${seconds}초 남음`);
}
function render(){
  if(!state)return;
  $('#room-code').textContent=state.code;
  $('#stage-name').textContent=STAGES[state.stage]||state.stage;
  $('#hand-number').textContent=`ROUND #${state.hand}`;
  cards($('#dealer-cards'),state.dealerCards);
  $('#dealer-score').textContent=state.dealerTotal===null?'':String(state.dealerTotal);
  const actor=state.players.find(p=>p.id===state.turnId);
  $('#table-message').textContent=state.stage==='lobby'?'칩을 걸고 방장이 시작하면 딜러가 카드를 나눠줘요':
    state.stage==='result'?'결과를 확인하고 다음 라운드를 시작해요':
      actor?`${actor.name}님의 차례 · ${state.handIndex+1}번째 핸드`:'딜러가 카드를 확인하는 중…';
  renderHands();renderRoster();renderActions();renderResult();renderChat();timer();
}
function renderHands(){
  const root=$('#my-hands');root.replaceChildren();
  const me=state.players.find(p=>p.id===state.me.id);
  if(!me?.inRound){root.append(make('div','bj-one-hand','이번 라운드 관전 중'));return;}
  me.hands.forEach((h,i)=>{
    const active=state.turnId===me.id&&state.handIndex===i;
    const box=make('div',`bj-one-hand${active?' active':''}`);
    box.append(make('div','bj-hand-title',`내 핸드 ${i+1} · 베팅 ${fmt(h.wager)}`));
    const hand=make('div','bj-hand-cards');cards(hand,h.cards);box.append(hand);
    const status={playing:'진행 중',stood:'스탠드',bust:'버스트',blackjack:'블랙잭!'}[h.status]||h.status;
    box.append(make('div','bj-hand-status',`${h.score}점 · ${status}${h.doubled?' · 더블':''}`));
    if(active)box.append(make('div','timer-pill',''));root.append(box);
    if(active)box.querySelector('.timer-pill').setAttribute('data-bj-timer','');
  });
}
function renderRoster(){
  const root=$('#roster');root.replaceChildren();
  $('#player-count').textContent=`${state.players.length}/8`;
  for(const p of state.players){
    const row=make('div',`bj-roster-row${p.id===state.turnId?' active':''}`);
    row.append(make('div','bj-roster-name',p.name+(p.id===state.me.id?' (나)':'')+(p.id===state.hostId?' ♛':'')));
    row.append(make('div','bj-roster-chips',`◈ ${fmt(p.chips)}`));
    row.append(make('div','bj-roster-detail',`${p.online?'● 온라인':'○ 오프라인'} · ${p.inRound?p.hands.length+'핸드':'다음 베팅 '+p.nextBet+'칩'}`));
    for(const h of p.hands){
      const wrapper=make('div','bj-roster-cards');
      h.cards.forEach(c=>wrapper.append(card(c)));
      wrapper.append(make('span','bj-roster-detail',`${h.score}점 · ${fmt(h.wager)}칩`));row.append(wrapper);
    }
    root.append(row);
  }
}
function button(label,cls,click,disabled=false){const b=make('button',`btn ${cls}`,label);b.disabled=disabled;b.type='button';b.onclick=click;return b;}
function renderActions(){
  const root=$('#action-panel');root.replaceChildren();if(!state)return;
  const me=state.players.find(p=>p.id===state.me.id);
  if(['lobby','result'].includes(state.stage)){
    if(me.chips<10){
      root.append(button('가상 칩 1,000개 다시 받기','btn-secondary',()=>send({type:'rebuy'})));
      return;
    }
    root.append(make('div','bj-bet-label','다음 라운드 베팅'));
    const amount=make('span','bj-bet-value',String(me.nextBet));
    const slider=make('input','bj-bet-slider');slider.type='range';slider.min='0';slider.max=String(Math.min(200,Math.floor(me.chips/10)*10));slider.step='10';slider.value=String(Math.min(me.nextBet,Number(slider.max)));
    slider.oninput=()=>{amount.textContent=slider.value;};
    root.append(slider,amount);
    root.append(button('베팅 저장','btn-secondary',()=>{if(send({type:'bet',amount:Number(slider.value)}))toast('베팅 변경 요청을 보냈어요.');}));
    if(state.hostId===state.me.id){
      const eligible=state.players.some(p=>p.online&&p.chips>=10&&p.nextBet>=10&&p.nextBet<=p.chips);
      root.append(button(state.stage==='lobby'?'게임 시작 ↗':'다음 라운드 ↗','btn-primary',()=>send({type:'start',expectHand:state.hand}),!eligible));
    }else root.append(make('p',null,'방장이 게임을 시작하면 참여해요. 베팅 0은 관전입니다.'));
    return;
  }
  const legal=state.me.legal;
  if(!legal){root.append(make('p',null,'다른 플레이어의 차례예요. 손패를 확인해 주세요.'));return;}
  root.append(button('히트 (+1장)','bj-hit',()=>command('hit'),pendingAction||!legal.canHit));
  root.append(button('스탠드','bj-stand',()=>command('stand'),pendingAction));
  root.append(button('더블다운','bj-double',()=>command('double'),pendingAction||!legal.canDouble));
  root.append(button('스플릿','bj-split',()=>command('split'),pendingAction||!legal.canSplit));
  const t=make('span','bj-bet-label','');t.setAttribute('data-bj-timer','');root.append(t);
}
const OUTCOME={blackjack:'블랙잭 승리',win:'승리',push:'무승부',lose:'패배',bust:'버스트'};
function renderResult(){
  const root=$('#results');root.replaceChildren();
  if(state.stage!=='result'||!state.result){root.classList.add('hidden');return;}
  root.classList.remove('hidden');
  root.append(make('h3',null,`딜러 ${state.result.dealerTotal}점 · 라운드 #${state.hand} 결과`));
  for(const p of state.result.players){
    const total=p.hands.reduce((a,h)=>a+h.payout-h.wager,0);
    root.append(make('p',null,`${p.name} · ${p.hands.map((h,i)=>`핸드 ${i+1} ${OUTCOME[h.outcome]||h.outcome}`).join(' / ')} · 순변동 ${total>=0?'+':''}${fmt(total)}칩`));
  }
  if(state.proof)root.append(button('셔플 공정성 검증','btn-secondary',verifyShuffle));
}
function renderChat(){
  const root=$('#chat-messages');const messages=state.chat||[];
  const last=String(messages.at(-1)?.id||'');if(chatLastId===last)return;
  const nearEnd=root.scrollTop+root.clientHeight>=root.scrollHeight-40;
  root.replaceChildren();
  if(!messages.length)root.append(make('div','chat-empty','아직 메시지가 없어요.'));
  else for(const m of messages){const line=make('div','chat-message');line.append(make('b',null,m.name),make('span',null,m.text));root.append(line);}
  if(nearEnd||messages.length===1)root.scrollTop=root.scrollHeight;
  chatLastId=last;
}
async function verifyShuffle(){
  try{
    const proof=state.proof,deck=proof.deck;
    if(deck.length!==312)throw Error('덱이 6벌(312장)이 아니에요.');
    const cardCounts=new Map();deck.forEach(c=>cardCounts.set(c,(cardCounts.get(c)||0)+1));
    if(cardCounts.size!==52||[...cardCounts.values()].some(n=>n!==6))throw Error('덱 카드 수량이 올바르지 않아요.');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${proof.nonce}:${deck.join(',')}`));
    const hash=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==proof.commit||hash!==state.commit)throw Error('게임 시작 시의 셔플 해시와 달라요.');
    if(proof.dealerIndices.some((idx,i)=>deck[idx]!==state.result.dealerCards[i]))throw Error('딜러 카드 불일치');
    const dealtIds=new Set(),allIndices=[...proof.dealerIndices];
    for(const player of state.players){
      const indices=proof.playerIndices[player.id]||[];
      const actual=player.hands.flatMap(h=>h.cards);
      if(indices.length!==actual.length)throw Error('플레이어 카드 장수가 다릅니다.');
      // Splitting changes hand card order, so compare multisets of dealt cards.
      const actualCounts=new Map(),recordedCounts=new Map();
      actual.forEach(c=>actualCounts.set(c,(actualCounts.get(c)||0)+1));
      indices.forEach(i=>{const c=deck[i];recordedCounts.set(c,(recordedCounts.get(c)||0)+1);});
      if([...actualCounts.entries()].some(([c,n])=>recordedCounts.get(c)!==n))throw Error('플레이어의 카드가 셔플 결과와 일치하지 않아요.');
      indices.forEach(i=>allIndices.push(i));dealtIds.add(player.id);
    }
    if(new Set(allIndices).size!==allIndices.length)throw Error('카드 위치가 중복되어 있어요.');
    if(allIndices.some(i=>!Number.isInteger(i)||i<0||i>=312))throw Error('카드 위치 오류');
    toast('✅ 셔플 해시, 6덱 카드 수량, 딜러/플레이어 카드 배분이 일치합니다.');
  }catch(e){toast('❌ 검증 실패: '+e.message);}
}
$('#create-form').onsubmit=e=>{e.preventDefault();enter('create');};
$('#join-form').onsubmit=e=>{e.preventDefault();enter('join');};
$('#join-code').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,'').slice(0,6);
$('#invite-btn').onclick=async()=>{
  const url=`${location.origin}/blackjack.html?room=${session.code}`;
  try{await navigator.clipboard.writeText(url);toast('블랙잭 초대 링크를 복사했어요.');}catch{toast('초대 주소: '+url);}
};
$('#exit-btn').onclick=()=>{
  if(!confirm('게임 방에서 나갈까요? 게임 중에는 좌석이 남아 있고, 시간 초과 시 자동 스탠드합니다.'))return;
  if(['lobby','result'].includes(state?.stage))send({type:'leave'});
  const old=ws;ws=null;if(old){old.onclose=null;old.close();}
  clearTimeout(reconnectTimer);session=null;state=null;chatLastId='';localStorage.removeItem(STORAGE);
  history.replaceState(null,'','/blackjack.html');showLanding();
};
$('#chat-form').onsubmit=e=>{
  e.preventDefault();const input=$('#chat-input'),value=input.value.trim();
  if(value&&send({type:'chat',text:value}))input.value='';
};
setInterval(()=>{if(ws?.readyState===1){pingSent=performance.now();ws.send('ping');}},10000);
setInterval(timer,300);
(function init(){
  const invite=(new URLSearchParams(location.search).get('room')||'').toUpperCase();
  let saved;try{saved=JSON.parse(localStorage.getItem(STORAGE));}catch{}
  if(saved?.code&&(!invite||invite===saved.code)&&saved.member?.auth){session=saved;showGame();connect();}
  else showLanding();
})();
