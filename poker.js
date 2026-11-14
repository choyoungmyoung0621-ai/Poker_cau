// Authoritative, dependency-free Texas Hold'em rules. All chip values are integers.
export const BLINDS = { small: 10, big: 20 };
export const STARTING_CHIPS = 1000;
export const ACTION_MS = 25_000;
export const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const HAND_LABELS = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];
export const SUITS = ['S','H','D','C'];

export function secureIndex(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 2 ** 32) throw new Error('invalid random range');
  const range = 2 ** 32, limit = Math.floor(range / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}
export function makeDeck() { return SUITS.flatMap(s => Array.from({length:13},(_,i)=> `${i+2}${s}`)); }
export function shuffle() {
  const a = makeDeck();
  for(let i=a.length-1;i>0;i--) { const j=secureIndex(i+1); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
export function randomHex(bytes=24) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export async function sha256(s) {
  const digest=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const rank = card => Number(card.slice(0,-1));
const suit = card => card.at(-1);
function highStraight(values) {
  const uniq = [...new Set(values)].sort((a,b)=>b-a);
  if(uniq.includes(14)) uniq.push(1);
  for(let i=0;i<=uniq.length-5;i++) if(uniq[i]-uniq[i+4]===4) return uniq[i];
  return 0;
}
export function evaluateFive(cards) {
  if (cards.length!==5) throw new Error('Need five cards');
  const values=cards.map(rank).sort((a,b)=>b-a);
  const freq=new Map(); for(const v of values) freq.set(v,(freq.get(v)||0)+1);
  const groups=[...freq.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const flush=cards.every(c=>suit(c)===suit(cards[0]));
  const straight=highStraight(values);
  if(flush && straight) return [8,straight];
  if(groups[0][1]===4) return [7,groups[0][0],groups[1][0]];
  if(groups[0][1]===3 && groups[1][1]===2) return [6,groups[0][0],groups[1][0]];
  if(flush) return [5,...values];
  if(straight) return [4,straight];
  if(groups[0][1]===3) return [3,groups[0][0],...groups.slice(1).map(g=>g[0]).sort((a,b)=>b-a)];
  if(groups[0][1]===2 && groups[1][1]===2) {
    const pairVals=[groups[0][0],groups[1][0]].sort((a,b)=>b-a);
    return [2,...pairVals,groups[2][0]];
  }
  if(groups[0][1]===2) return [1,groups[0][0],...groups.slice(1).map(g=>g[0]).sort((a,b)=>b-a)];
  return [0,...values];
}
export function compareRanks(a,b) {
  for(let i=0;i<Math.max(a.length,b.length);i++) {
    const delta=(a[i]??0)-(b[i]??0); if(delta!==0) return Math.sign(delta);
  }
  return 0;
}
export function bestHand(cards) {
  if(cards.length!==7) throw new Error('Need seven cards');
  let best=null, bestCards=null;
  for(let a=0;a<3;a++) for(let b=a+1;b<4;b++) for(let c=b+1;c<5;c++)
    for(let d=c+1;d<6;d++) for(let e=d+1;e<7;e++) {
      const five=[cards[a],cards[b],cards[c],cards[d],cards[e]];
      const s=evaluateFive(five);
      if(!best || compareRanks(s,best)>0) { best=s; bestCards=five; }
    }
  return {score:best, cards:bestCards, label: best[0]===8&&best[1]===14 ? '로열 플러시' : HAND_LABELS[best[0]]};
}
export function nextPlayer(list, fromSeat) {
  if(!list.length) return null;
  return [...list].sort((a,b)=>((a.seat-fromSeat+8)%8||8)-((b.seat-fromSeat+8)%8||8))[0];
}
export function makeGame(code,owner) {
  return {code, players:[makePlayer(owner,0)],hostId:owner.id,stage:'lobby',hand:0,dealerSeat:-1,
    smallBlind:BLINDS.small,bigBlind:BLINDS.big, community:[],communityIndices:[],deck:[],deckCursor:0,
    nonce:null,commit:null,dealtPositions:{},proof:null,
    currentBet:0,minRaise:BLINDS.big,acted:[],pending:[],turnId:null,deadline:null,
    result:null,chat:[],history:[],version:0, lastUpdate:Date.now()};
}
export function makePlayer(data,seat) {
  return {id:data.id,auth:data.auth,name:data.name,seat,chips:STARTING_CHIPS,
    bet:0,committed:0,inHand:false,folded:false,allIn:false,hole:[],ops:[]};
}
export function potAmount(g) { return g.players.reduce((n,p)=>n+p.committed,0); }
export function contenders(g) {return g.players.filter(p=>p.inHand&&!p.folded);}
export function actionable(g) {return contenders(g).filter(p=>p.chips>0);}
function pay(p,amount) {
  const n=Math.min(p.chips,Math.max(0,amount));
  p.chips-=n;p.bet+=n;p.committed+=n; p.allIn=p.chips===0; return n;
}
function takeCard(g) {
  if(g.deckCursor>=g.deck.length) throw new Error('Deck empty');
  const idx=g.deckCursor++;return [g.deck[idx],idx];
}
function resetStreet(g) {
  for(const p of g.players) p.bet=0;
  g.currentBet=0;g.minRaise=g.bigBlind;g.acted=[];
  g.pending=actionable(g).map(p=>p.id);
}
function addBoard(g,n) {
  for(let i=0;i<n;i++) {const [card,idx]=takeCard(g); g.community.push(card);g.communityIndices.push(idx);}
}
function dealProof(g) {
  g.proof={nonce:g.nonce,deck:g.deck,commit:g.commit,dealtPositions:g.dealtPositions,communityIndices:g.communityIndices};
}
export async function startHand(g,onlineIds) {
  if(!['lobby','showdown'].includes(g.stage)) throw Error('이미 게임이 진행 중이에요.');
  const selected=g.players.filter(p=>p.chips>0 && onlineIds.has(p.id));
  if(selected.length<2) throw Error('온라인에 접속한 플레이어가 2명 이상 필요해요.');
  g.hand++;g.stage='preflop';g.result=null;g.proof=null;
  g.community=[];g.communityIndices=[];g.deck=shuffle();g.deckCursor=0;
  g.nonce=randomHex(24);g.commit=await sha256(`${g.nonce}:${g.deck.join(',')}`);g.dealtPositions={};
  const selectedIds=new Set(selected.map(p=>p.id));
  for(const p of g.players) { p.bet=0;p.committed=0;p.inHand=selectedIds.has(p.id);p.folded=false;p.allIn=false;p.hole=[]; }
  const dealer=g.dealerSeat<0 ? selected[secureIndex(selected.length)] : nextPlayer(selected,g.dealerSeat);
  g.dealerSeat=dealer.seat;
  const sb=selected.length===2?dealer:nextPlayer(selected,g.dealerSeat);
  const bb=nextPlayer(selected,sb.seat);
  pay(sb,g.smallBlind);pay(bb,g.bigBlind);
  g.currentBet=g.bigBlind;g.minRaise=g.bigBlind;g.acted=[];
  let cursor=g.dealerSeat;
  const order=[];
  for(let i=0;i<selected.length;i++) { const p=nextPlayer(selected,cursor);order.push(p);cursor=p.seat; }
  for(let round=0;round<2;round++) for(const p of order) {
    const [card,idx]=takeCard(g);p.hole.push(card);
    if(!g.dealtPositions[p.id]) g.dealtPositions[p.id]=[];
    g.dealtPositions[p.id].push(idx);
  }
  g.pending=actionable(g).map(p=>p.id);
  progress(g,bb.seat);
}
function choosePending(g,seat) {
  return nextPlayer(g.players.filter(p=>g.pending.includes(p.id)),seat);
}
function distributeOdd(g,winners,amount,payout) {
  const ordered=[...winners].sort((a,b)=>((a.seat-g.dealerSeat+8)%8||8)-((b.seat-g.dealerSeat+8)%8||8));
  const share=Math.floor(amount/ordered.length), extra=amount%ordered.length;
  ordered.forEach((p,i)=>{payout[p.id]=(payout[p.id]||0)+share+(i<extra?1:0);});
}
export function settle(g,byFold=false) {
  const live=contenders(g);
  if(live.length<1) throw Error('No winner');
  const pool=potAmount(g), payouts={},pots=[];
  const hands={};
  if(byFold || live.length===1) {
    payouts[live[0].id]=pool;
    pots.push({amount:pool,winners:[live[0].id]});
  } else {
    for(const p of live) hands[p.id]=bestHand([...p.hole,...g.community]);
    const levels=[...new Set(g.players.filter(p=>p.inHand&&p.committed>0).map(p=>p.committed))].sort((a,b)=>a-b);
    let last=0;
    for(const level of levels) {
      const participants=g.players.filter(p=>p.inHand&&p.committed>=level);
      const amount=(level-last)*participants.length;last=level;
      if(!amount) continue;
      let eligible=live.filter(p=>p.committed>=level);
      // Dead chips from a folded high bettor belong to the preceding contested pot.
      if(eligible.length===0) eligible=live.filter(p=>p.committed===Math.max(...live.map(q=>q.committed)));
      const best=eligible.reduce((a,p)=> !a || compareRanks(hands[p.id].score,hands[a.id].score)>0?p:a,null);
      const winners=eligible.filter(p=>compareRanks(hands[p.id].score,hands[best.id].score)===0);
      distributeOdd(g,winners,amount,payouts);
      pots.push({amount,winners:winners.map(p=>p.id)});
    }
  }
  for(const p of g.players) p.chips+=payouts[p.id]||0;
  const paid=Object.values(payouts).reduce((a,b)=>a+b,0);
  if(paid!==pool) throw Error(`Chip accounting mismatch: ${paid} != ${pool}`);
  g.result={type:byFold?'fold':'showdown',payouts:Object.entries(payouts).filter(([,n])=>n>0).map(([id,amount])=>({id,amount,name:g.players.find(p=>p.id===id)?.name})),
    hands:Object.fromEntries(Object.entries(hands).map(([id,h])=>[id,{label:h.label,cards:h.cards}])),pots};
  g.stage='showdown';g.turnId=null;g.deadline=null;g.pending=[];
  dealProof(g);
  const line=g.result.payouts.map(p=>`${p.name} +${p.amount}`).join(', ');
  g.history.unshift(`핸드 #${g.hand}: ${line}`);g.history=g.history.slice(0,20);
}
export function progress(g,fromSeat) {
  for(let safety=0;safety<10;safety++) {
    if(contenders(g).length===1) {settle(g,true);return;}
    g.pending=g.pending.filter(id=>actionable(g).some(p=>p.id===id));
    // If all opponents are all-in, there's no one left to bet against.
    const able=actionable(g);
    if(able.length===1 && able[0].bet>=g.currentBet) g.pending=[];
    if(g.pending.length) {
      const p=choosePending(g,fromSeat);
      if(!p) throw Error('Missing next actor');
      g.turnId=p.id;g.deadline=Date.now()+ACTION_MS;return;
    }
    if(g.stage==='river'){settle(g);return;}
    const i=STREETS.indexOf(g.stage);
    if(i<0 || i>=STREETS.length-1) throw Error('Bad betting street');
    g.stage=STREETS[i+1];addBoard(g,g.stage==='flop'?3:1);
    resetStreet(g);fromSeat=g.dealerSeat;
  }
  throw Error('Street progression exceeded safe limit');
}
export function legal(g,pid) {
  const p=g.players.find(p=>p.id===pid);
  if(!p||g.turnId!==pid||!p.inHand||p.folded||p.allIn||!STREETS.includes(g.stage)) return null;
  const toCall=Math.max(0,g.currentBet-p.bet);
  const maxTo=p.bet+p.chips;
  const minTo=g.currentBet===0?g.bigBlind:g.currentBet+g.minRaise;
  const canRaise=!g.acted.includes(pid) && maxTo>g.currentBet;
  return {toCall,callAmount:Math.min(p.chips,toCall),minTo,maxTo,canRaise,canCheck:toCall===0,canCall:toCall>0};
}
export function act(g,pid,action,to) {
  const p=g.players.find(p=>p.id===pid), opts=legal(g,pid);
  if(!opts) throw Error('지금은 행동할 차례가 아니에요.');
  const oldBet=g.currentBet; const alreadyActed=g.acted.includes(pid);
  if(action==='fold'){p.folded=true;}
  else if(action==='check'){if(!opts.canCheck) throw Error('먼저 콜하거나 폴드해야 해요.');}
  else if(action==='call'){if(!opts.canCall) throw Error('콜할 금액이 없어요.');pay(p,opts.callAmount);}
  else if(action==='raise'){
    if(!opts.canRaise) throw Error('이번 차례에는 레이즈를 다시 할 수 없어요.');
    if(!Number.isSafeInteger(to)||to<=g.currentBet||to>opts.maxTo) throw Error('유효하지 않은 레이즈 금액이에요.');
    const full=to>=opts.minTo;
    if(!full && to!==opts.maxTo) throw Error('최소 레이즈보다 작게 베팅할 수 없어요.');
    pay(p,to-p.bet);g.currentBet=to;
    if(full){g.minRaise=to-oldBet;g.acted=[pid];}
    else if(oldBet===0) {g.acted=[pid];}
  } else throw Error('알 수 없는 행동이에요.');
  if(action!=='raise' || g.currentBet===oldBet || (to<opts.minTo && oldBet!==0)) {
    if(!g.acted.includes(pid)) g.acted.push(pid);
  }
  g.pending=actionable(g).filter(q=>!g.acted.includes(q.id) || q.bet<g.currentBet).map(q=>q.id);
  // With a short raise, earlier callers must respond, but cannot re-raise.
  if(action==='raise' && !alreadyActed && to<opts.minTo && oldBet===0) {
    // An incomplete opening bet does not reopen previously completed actions,
    // but those players may call. Keep the betting-order validation conservative.
  }
  progress(g,p.seat);
}
export function view(g,viewerId,onlineIds) {
  const p=g.players.find(x=>x.id===viewerId);
  return {type:'state',now:Date.now(),version:g.version,code:g.code,hand:g.hand,stage:g.stage,hostId:g.hostId,
    smallBlind:g.smallBlind,bigBlind:g.bigBlind,dealerSeat:g.dealerSeat,turnId:g.turnId,deadline:g.deadline,
    currentBet:g.currentBet,minRaise:g.minRaise,pot:potAmount(g),community:g.community,
    players:g.players.map(q=>({id:q.id,name:q.name,seat:q.seat,chips:q.chips,bet:q.bet,committed:q.committed,
      inHand:q.inHand,folded:q.folded,allIn:q.allIn,online:onlineIds.has(q.id),
      showCards:g.stage==='showdown'&&q.inHand&&!q.folded?q.hole:null})),
    me:{id:p.id,name:p.name,seat:p.seat,hole:p.hole,legal:legal(g,p.id)},
    result:g.result,commit:g.commit,proof:g.stage==='showdown'?g.proof:null,
    chat:g.chat.slice(-25),history:g.history.slice(0,12)};
}
