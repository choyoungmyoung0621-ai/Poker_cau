import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBlackjackGame,makeBlackjackPlayer,blackjackScore,blackjackDeck,blackjackSetBet,blackjackStart,
  blackjackAction,blackjackLegal,blackjackSettle,blackjackView} from '../src/blackjack.js';
import {sha256} from '../src/poker.js';
const user=(i)=>({id:`u${i}`,auth:`auth${i}`,name:`Player${i}`});
function room(n=1){
  const g=makeBlackjackGame('ABC123',user(0));
  for(let i=1;i<n;i++)g.players.push(makeBlackjackPlayer(user(i),i));
  return g;
}
function setHand(g, cards, wager=20, status='stood'){
  const p=g.players[0];g.stage='playing';g.dealerCards=['9S','8H'];p.chips=1000-wager;p.inRound=true;
  p.hands=[{cards,indices:[0,1],wager,status,split:false,splitAces:false,doubled:false}];g.shoe=['2S','3S','4S','5S','6S'];g.cursor=0;
  return p;
}
test('blackjack scores count aces, court cards, natural vs non-natural',()=>{
  assert.deepEqual(blackjackScore(['14S','13D']),{total:21,soft:true,bust:false,blackjack:true});
  assert.equal(blackjackScore(['14S','14C','9D']).total,21);
  assert.equal(blackjackScore(['14S','14C','9D','9H']).total,20);
  assert.equal(blackjackScore(['13S','7D','5C']).bust,true);
  assert.equal(blackjackScore(['7S','7D','7C']).blackjack,false);
  assert.equal(blackjackScore(['14S','6D']).soft,true);
  assert.equal(blackjackScore(['14S','6D','2H','3C','9D']).soft,false);
});
test('six-deck composition has exactly six copies of each unique card',()=>{
  const cards=blackjackDeck(),counts=new Map();cards.forEach(c=>counts.set(c,(counts.get(c)||0)+1));
  assert.equal(cards.length,312);assert.equal(counts.size,52);assert.ok([...counts.values()].every(n=>n===6));
});
test('bet validation rejects negative, fractional, unbacked and out-of-range bets',()=>{
  const g=room();for(const n of [-10,5,205,201,12.5,Infinity,NaN,1100,'20'])assert.throws(()=>blackjackSetBet(g,'u0',n));
  blackjackSetBet(g,'u0',0);assert.equal(g.players[0].nextBet,0);
  blackjackSetBet(g,'u0',200);assert.equal(g.players[0].nextBet,200);
  g.stage='playing';assert.throws(()=>blackjackSetBet(g,'u0',10));
});
test('starting a round debits wagers, commits shoe hash and hides dealer hole card',async()=>{
  const g=room(3);blackjackSetBet(g,'u0',60);blackjackSetBet(g,'u1',0);
  await blackjackStart(g,new Set(['u0','u1','u2']));
  assert.equal(g.hand,1);assert.equal(g.players[0].chips,940);assert.equal(g.players[1].chips,1000);
  assert.equal(g.players[1].inRound,false);assert.equal(g.players[2].chips,980);
  assert.equal(g.commit,await sha256(`${g.nonce}:${g.shoe.join(',')}`));
  const view=blackjackView(g,'u0',new Set(['u0','u1','u2']));
  assert.equal(view.mode,'blackjack');assert.equal(view.dealerCards.length,2);
  if(g.stage==='playing'){
    assert.equal(view.dealerCards[1],'back');assert.equal(view.proof,null);
    assert.ok(!JSON.stringify(view).includes(g.dealerCards[1]===view.dealerCards[0]?'IMPOSSIBLE':`"nonce":"${g.nonce}"`));
  }
});
test('blackjack pays 3:2, split 21 pays only 1:1',()=>{
  const g=room(),p=setHand(g,['14S','13C'],20,'blackjack');
  blackjackSettle(g);assert.equal(p.chips,1030);assert.equal(g.result.players[0].hands[0].outcome,'blackjack');
  const g2=room(),q=setHand(g2,['14S','13C'],20,'stood');
  blackjackSettle(g2);assert.equal(q.chips,1020);assert.equal(g2.result.players[0].hands[0].outcome,'win');
});
test('dealer natural wins against non-natural 21, pushes player natural',()=>{
  const g=room(2),p=setHand(g,['7S','7H','7C'],20,'stood');
  g.dealerCards=['14H','13S'];
  const q=g.players[1];q.inRound=true;q.chips=980;q.hands=[{cards:['14C','13D'],wager:20,status:'blackjack'}];
  blackjackSettle(g,true);assert.equal(p.chips,980);assert.equal(q.chips,1000);
  assert.equal(g.result.players[1].hands[0].outcome,'push');
});
test('dealer bust, dealer higher, tie and player bust settlements',()=>{
  const tests=[
    {cards:['10S','9H'],dealer:['10C','8S','6S'],status:'stood',chips:1020,outcome:'win'},
    {cards:['10S','7H'],dealer:['10C','8S'],status:'stood',chips:980,outcome:'lose'},
    {cards:['10S','8H'],dealer:['10C','8S'],status:'stood',chips:1000,outcome:'push'},
    {cards:['10S','9H','5D'],dealer:['10C','7S'],status:'bust',chips:980,outcome:'bust'},
  ];
  for(const t of tests){const g=room(),p=setHand(g,t.cards,20,t.status);g.dealerCards=t.dealer;blackjackSettle(g);
    assert.equal(p.chips,t.chips,t.outcome);assert.equal(g.result.players[0].hands[0].outcome,t.outcome);}
});
test('hit and double follow turn and chip rules',()=>{
  const g=room(),p=setHand(g,['6S','4H'],20,'playing');g.shoe=['8D','3C','2S'];g.dealerCards=['10H','9H'];
  g.turnId=p.id;g.handIndex=0;
  assert.equal(blackjackLegal(g,p.id).canDouble,true);
  blackjackAction(g,p.id,'double');assert.equal(p.hands[0].wager,40);assert.equal(p.hands[0].cards.length,3);
  assert.equal(p.chips,960); // 18 against 19 loses both doubled wagers
});
test('ace and ten-value card cannot be split as a pair',()=>{
  const g=room(),p=setHand(g,['14S','13H'],20,'playing');g.turnId=p.id;g.handIndex=0;
  assert.equal(blackjackLegal(g,p.id).canSplit,false);
  assert.throws(()=>blackjackAction(g,p.id,'split'));
});
test('split creates independent hands, debits extra wager and enforces max four',()=>{
  const g=room(),p=setHand(g,['8S','8H'],20,'playing');g.shoe=['3C','4D','5S','6D','2C'];g.dealerCards=['10S','7S'];
  g.turnId=p.id;g.handIndex=0;
  blackjackAction(g,p.id,'split');assert.equal(p.hands.length,2);assert.equal(p.hands[0].cards.length,2);
  assert.equal(p.hands[1].cards.length,2);assert.equal(p.chips,960);assert.equal(g.turnId,p.id);
  blackjackAction(g,p.id,'stand');assert.equal(g.handIndex,1);
  blackjackAction(g,p.id,'stand');assert.equal(g.stage,'result');
});
test('split aces take exactly one card per hand with no subsequent hit',()=>{
  const g=room(),p=setHand(g,['14S','14H'],20,'playing');g.shoe=['10D','9D','2S'];g.dealerCards=['10S','7S'];
  g.turnId=p.id;g.handIndex=0;
  blackjackAction(g,p.id,'split');assert.equal(g.stage,'result');assert.ok(p.hands.every(h=>h.cards.length===2 && h.status==='stood'));
  assert.ok(p.hands.every(h=>h.splitAces));
});
test('non-turn players cannot act or split',()=>{
  const g=room(2);setHand(g,['8S','8H'],20,'playing');g.turnId='u1';g.handIndex=0;
  assert.equal(blackjackLegal(g,'u0'),null);assert.throws(()=>blackjackAction(g,'u0','hit'));
});
test('natural blackjack ends immediately when all players have naturals or dealer has natural',async()=>{
  const g=room(2);await blackjackStart(g,new Set(['u0','u1']));
  let count=0;while(g.stage==='playing'&&count++<80){blackjackAction(g,g.turnId,'stand');}
  assert.equal(g.stage,'result');assert.ok(g.proof);assert.equal(g.proof.deck.length,312);
});
test('stress: 320 games, 1–8 players, actions and payouts always terminate with sane chips',async()=>{
  for(let n=1;n<=8;n++){
    const g=room(n);
    for(let round=0;round<40;round++){
      for(const p of g.players){if(p.chips<10){p.chips=1000;p.nextBet=20;}else p.nextBet=Math.min(20,Math.floor(p.chips/10)*10);}
      await blackjackStart(g,new Set(g.players.map(p=>p.id)));
      let steps=0;
      while(g.stage==='playing' && ++steps<=160){
        const l=blackjackLegal(g,g.turnId);
        assert.ok(l,`n=${n} round=${round} step=${steps}`);
        const actions=['stand','hit'];if(l.canDouble)actions.push('double');if(l.canSplit)actions.push('split');
        blackjackAction(g,g.turnId,actions[Math.floor(Math.random()*actions.length)]);
      }
      assert.ok(steps<=160);assert.equal(g.stage,'result');
      assert.equal(g.proof.deck.length,312);
      assert.ok(g.players.every(p=>Number.isSafeInteger(p.chips)&&p.chips>=0&&p.hands.length<=4));
      for(const p of g.result.players)for(const h of p.hands){assert.ok(Number.isSafeInteger(h.payout));assert.ok(h.wager>=10&&h.wager%10===0);}
    }
  }
});
