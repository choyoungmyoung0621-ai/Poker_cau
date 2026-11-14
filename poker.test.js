import test from 'node:test';
import assert from 'node:assert/strict';
import {makeGame,makePlayer,makeDeck,shuffle,sha256,bestHand,evaluateFive,compareRanks,startHand,act,legal,settle,view,contenders,potAmount} from '../src/poker.js';
const member=(name,i)=>({id:'p'+i,auth:'secret'+i,name});
const gameWith=(count)=>{const g=makeGame('ABCDEF',member('나',0));for(let i=1;i<count;i++)g.players.push(makePlayer(member('친구'+i,i),i));return g;};
const conservation=g=>assert.equal(g.players.reduce((sum,p)=>sum+p.chips,0)+(g.stage==='showdown'?0:potAmount(g)),1000*g.players.length);
const score=cards=>bestHand(cards).score;

test('Cryptographic deck has 52 unique cards, original deck valid',()=>{
  assert.equal(makeDeck().length,52);
  for(let k=0;k<20;k++){const cards=shuffle();assert.equal(new Set(cards).size,52);assert.equal(cards.length,52);}
});
test('hand rankings cover royal, straight flush, quads, full house, flush, straight, trips, two pair, pair, high',()=>{
  const examples=[
    ['14S','13S','12S','11S','10S','2H','3D'],
    ['9S','8S','7S','6S','5S','2H','3D'],
    ['12S','12H','12D','12C','3S','2H','4D'],
    ['10S','10H','10D','9S','9C','2H','3D'],
    ['14S','10S','8S','5S','3S','2H','4D'],
    ['14S','2H','3D','4C','5S','9H','12D'],
    ['11S','11H','11C','5D','7S','3H','2C'],
    ['11S','11H','7C','7S','4D','3H','2C'],
    ['11S','11H','8C','5S','4D','3H','2C'],
    ['14S','13H','9C','7S','5D','3H','2C']];
  assert.deepEqual(examples.map(x=>score(x)[0]),[8,8,7,6,5,4,3,2,1,0]);
  assert.equal(score(examples[0])[1],14);
  assert.equal(score(examples[5])[1],5);
  assert.ok(compareRanks(score(examples[0]),score(examples[1]))>0);
});
test('Wheel straight beats ace-high non-straight',()=>{
  assert.deepEqual(evaluateFive(['14S','2H','3D','4C','5S']),[4,5]);
  assert.ok(compareRanks(evaluateFive(['14S','2H','3D','4C','5S']),evaluateFive(['14S','13H','9D','8C','6S']))>0);
});
test('heads-up button is small blind and acts first preflop',async()=>{
  const g=gameWith(2);await startHand(g,new Set(['p0','p1']));
  const dealer=g.players.find(p=>p.seat===g.dealerSeat);
  assert.equal(dealer.bet,10);assert.equal(g.turnId,dealer.id);
  assert.equal(g.players.find(p=>p.id!==dealer.id).bet,20);
  conservation(g);
});
test('three-player opening action starts left of big blind',async()=>{
  const g=gameWith(3);await startHand(g,new Set(['p0','p1','p2']));
  const dealer=g.players.find(p=>p.seat===g.dealerSeat);
  assert.equal(g.turnId,dealer.id);conservation(g);
});
test('full unraised 8-player hand progresses through streets and pays out correctly',async()=>{
  const g=gameWith(8);await startHand(g,new Set(g.players.map(p=>p.id)));
  let safety=0;
  while(g.stage!=='showdown'&&safety++<80){
    const opt=legal(g,g.turnId);assert.ok(opt);act(g,g.turnId,opt.toCall?'call':'check');conservation(g);
  }
  assert.equal(g.stage,'showdown');assert.ok(safety<80);
  assert.equal(g.community.length,5);
  assert.equal(g.players.reduce((n,p)=>n+p.chips,0),8000);
  assert.ok(g.proof?.nonce);assert.equal(g.proof.deck.length,52);
  assert.equal(await sha256(`${g.proof.nonce}:${g.proof.deck.join(',')}`),g.proof.commit);
  for(const p of g.players)assert.deepEqual(p.hole,p.hole.map((_,i)=>g.proof.deck[g.proof.dealtPositions[p.id][i]]));
});
test('different audiences never receive another player\'s hole cards during hand',async()=>{
  const g=gameWith(2);await startHand(g,new Set(['p0','p1']));
  const v=view(g,'p0',new Set(['p0','p1']));
  assert.deepEqual(v.me.hole,g.players[0].hole);
  assert.equal(v.players[1].showCards,null);
  assert.ok(!JSON.stringify(v).includes(g.players[1].hole[0]+'","'+g.players[1].hole[1]));
  assert.equal(v.proof,null);
});
test('turn order validates actions and rejects out-of-turn, small raises, repeated raises',async()=>{
  const g=gameWith(3);await startHand(g,new Set(g.players.map(p=>p.id)));
  const other=g.players.find(p=>p.id!==g.turnId);
  assert.throws(()=>act(g,other.id,'fold'),/차례/);
  const pid=g.turnId,op=legal(g,pid);
  assert.throws(()=>act(g,pid,'raise',g.currentBet+1),/최소/);
  const before=potAmount(g);
  act(g,pid,'raise',op.minTo);
  assert.ok(potAmount(g)>before);
  assert.ok(!g.acted.includes(g.turnId));
});
test('fold winner gets all chips in pot and no betting left',async()=>{
  const g=gameWith(2);await startHand(g,new Set(['p0','p1']));
  act(g,g.turnId,'fold');
  assert.equal(g.stage,'showdown');assert.equal(g.result.type,'fold');
  assert.equal(g.players.reduce((a,p)=>a+p.chips,0),2000);
});
test('all-in creates main + side pots for different winners',()=>{
  const g=gameWith(3);g.stage='river';g.dealerSeat=2;
  g.community=['2S','3H','7D','9C','13S'];
  g.players[0].hole=['13H','13D']; // trips 13 with board K; actually three kings
  g.players[1].hole=['9H','9D']; // trip 9
  g.players[2].hole=['8H','8D']; // pair 8
  [g.players[0],g.players[1],g.players[2]].forEach((p,i)=>{p.inHand=true;p.folded=false;p.committed=[100,300,300][i];p.chips=1000-p.committed;});
  settle(g);
  assert.equal(g.stage,'showdown');
  assert.equal(g.result.pots.length,2);
  assert.equal(g.result.pots[0].amount,300);
  assert.equal(g.result.pots[1].amount,400);
  assert.equal(g.players[0].chips,1200); // paid 300 on 100 invested
  assert.equal(g.players[1].chips,1100); // paid 400 on 300 invested
  assert.equal(g.players[2].chips,700);
  assert.equal(g.players.reduce((n,p)=>n+p.chips,0),3000);
});
test('odd chip goes to first winner left of dealer',()=>{
  const g=gameWith(3);g.stage='river';g.dealerSeat=0;
  g.community=['2S','3S','4S','5S','6S'];
  g.players.forEach((p,i)=>{p.inHand=true;p.folded=i===2;p.committed=21;p.chips=979;p.hole=['8H','9D'];});
  settle(g);
  assert.equal(g.result.payouts.reduce((n,x)=>n+x.amount,0),63);
  assert.equal(g.players[1].chips,1011); // left of seat 0 gets odd chip, 32
  assert.equal(g.players[0].chips,1010);
  assert.equal(g.players[2].chips,979);
});
test('automatic runout with all-in players and one active player',async()=>{
  const g=gameWith(2);await startHand(g,new Set(['p0','p1']));
  const p=g.players.find(p=>p.id===g.turnId);
  act(g,p.id,'raise',1000);
  const facing=g.turnId;act(g,facing,'call');
  assert.equal(g.stage,'showdown');assert.equal(g.community.length,5);
  assert.equal(g.players.reduce((n,p)=>n+p.chips,0),2000);
});
test('next hand restores bets while retaining chips and rotates dealer',async()=>{
  const g=gameWith(4);await startHand(g,new Set(g.players.map(p=>p.id)));
  const prev=g.dealerSeat;
  while(g.stage!=='showdown') {const o=legal(g,g.turnId);act(g,g.turnId,o.toCall?'call':'check');}
  const chips=g.players.map(p=>p.chips);
  await startHand(g,new Set(g.players.map(p=>p.id)));
  assert.notEqual(g.dealerSeat,prev);
  assert.deepEqual(g.players.map(p=>p.chips+p.committed),chips);
  conservation(g);
});
test('stress test: 400 multi-player hands preserve chips and always finish',async()=>{
  let actions=0;
  for(let k=0;k<400;k++){
    const count=2+k%7,g=gameWith(count);
    await startHand(g,new Set(g.players.map(p=>p.id)));
    let steps=0;
    while(g.stage!=='showdown' && steps++<200){
      const p=g.turnId,options=legal(g,p);
      assert.ok(options,`missing actor in hand ${k}`);
      const r=Math.random();
      let action='check',to;
      if(r<0.08)action='fold';
      else if(r<0.26 && options.canRaise){action='raise';to=r<0.13?options.maxTo:Math.min(options.minTo,options.maxTo);}
      else action=options.toCall?'call':'check';
      act(g,p,action,to);actions++;
      conservation(g);
    }
    assert.ok(steps<200,`stuck game ${k}`);
    assert.equal(g.stage,'showdown');
    assert.equal(g.players.reduce((n,p)=>n+p.chips,0),count*1000);
    assert.ok(g.result.payouts.length);
  }
  assert.ok(actions>1000);
});
