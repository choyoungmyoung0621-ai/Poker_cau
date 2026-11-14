import { DurableObject } from 'cloudflare:workers';
import {makeGame,makePlayer,randomHex,secureIndex,startHand,act,legal,view,STREETS} from './poker.js';
import {makeBlackjackGame,makeBlackjackPlayer,blackjackSetBet,blackjackStart,blackjackAction,blackjackAdvance,blackjackLegal,blackjackView} from './blackjack.js';

const ROOM_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const normalizeName=x=>typeof x==='string'?x.trim().replace(/\s+/g,' ').slice(0,16):'';
const codeValid=x=>/^[A-HJ-NP-Z2-9]{6}$/.test(x);
const newCode=()=>Array.from({length:6},()=>ROOM_ALPHABET[secureIndex(ROOM_ALPHABET.length)]).join('');
const onlineIds=ctx=>new Set(ctx.getWebSockets().filter(s=>s.readyState===1).map(s=>s.deserializeAttachment()?.playerId).filter(Boolean));

export default {
  async fetch(request,env){
    const u=new URL(request.url), route=u.pathname;
    if(route==='/api/health') return json({ok:true,service:'friend-poker-room'});
    if(!route.startsWith('/api/')) return env.ASSETS.fetch(request);
    const origin=request.headers.get('origin');
    if(origin && origin!==u.origin) return json({error:'허용되지 않은 요청 출처입니다.'},403);
    if(request.method==='POST' && (route==='/api/rooms'||/^\/api\/rooms\/[A-HJ-NP-Z2-9]{6}\/join$/.test(route))){
      if(Number(request.headers.get('content-length')||0)>2048) return json({error:'요청이 너무 깁니다.'},413);
      let body;try{const raw=await request.text();if(raw.length>2048) return json({error:'요청이 너무 깁니다.'},413);body=JSON.parse(raw);}catch{return json({error:'잘못된 요청입니다.'},400);}
      const name=normalizeName(body?.name);
      const mode=body?.mode ?? 'poker';
      if(!['poker','blackjack'].includes(mode)) return json({error:'지원하지 않는 게임 종류입니다.'},400);
      if(name.length<2 || name.length>16) return json({error:'닉네임은 2~16자로 입력해 주세요.'},400);
      const member={id:randomHex(12),auth:randomHex(32),name};
      if(route==='/api/rooms') {
        for(let i=0;i<5;i++) {
          const code=newCode(),stub=env.ROOMS.get(env.ROOMS.idFromName(code));
          const resp=await stub.fetch(new Request('https://room.internal/internal/create',{method:'POST',body:JSON.stringify({code,member,mode})}));
          if(resp.status===409) continue;
          if(resp.ok) return json({code,member,mode,invite:`${u.origin}/${mode==='blackjack'?'blackjack.html':''}?room=${code}`},201);
          return json({error:'방을 생성하지 못했어요.'},500);
        }
        return json({error:'방 코드 생성에 실패했어요. 다시 시도해 주세요.'},503);
      }
      const code=route.split('/')[3],stub=env.ROOMS.get(env.ROOMS.idFromName(code));
      const resp=await stub.fetch(new Request('https://room.internal/internal/join',{method:'POST',body:JSON.stringify({member,mode})}));
      const ans=await resp.json();
      return json(resp.ok?{code,member,mode,invite:`${u.origin}/${mode==='blackjack'?'blackjack.html':''}?room=${code}`} :ans,resp.status);
    }
    if(request.method==='GET' && route.startsWith('/api/ws/')) {
      const code=route.slice('/api/ws/'.length).toUpperCase();
      if(!codeValid(code)) return json({error:'잘못된 방 코드입니다.'},400);
      if(request.headers.get('upgrade')?.toLowerCase()!=='websocket') return json({error:'WebSocket 연결이 필요해요.'},426);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return json({error:'찾을 수 없는 경로입니다.'},404);
  }
};

export class PokerRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ready=this.ctx.blockConcurrencyWhile(async()=>{this.game=await this.ctx.storage.get('game')||null;});
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  async persist(){
    this.game.version++;
    this.game.lastUpdate=Date.now();
    await this.ctx.storage.put('game',this.game);
    if(this.game.deadline && (STREETS.includes(this.game.stage) || (this.game.mode==='blackjack' && this.game.stage==='playing'))) await this.ctx.storage.setAlarm(this.game.deadline);
    else await this.ctx.storage.deleteAlarm();
  }
  send(ws,data){try{ws.send(JSON.stringify(data));}catch{ /* socket may have closed */ }}
  broadcast(){
    if(!this.game) return;
    const on=onlineIds(this.ctx);
    for(const ws of this.ctx.getWebSockets()){
      if(ws.readyState!==1) continue;
      const p=this.game.players.find(p=>p.id===ws.deserializeAttachment()?.playerId);
      if(p) this.send(ws,this.game.mode==='blackjack'?blackjackView(this.game,p.id,on):view(this.game,p.id,on));
    }
  }
  async fetch(request){
    await this.ready;
    const path=new URL(request.url).pathname;
    if(path==='/internal/create' && request.method==='POST') {
      if(this.game) return json({error:'이미 존재하는 방입니다.'},409);
      const {code,member,mode}=await request.json();
      this.game=mode==='blackjack'?makeBlackjackGame(code,member):makeGame(code,member);await this.persist();return json({ok:true},201);
    }
    if(path==='/internal/join' && request.method==='POST') {
      if(!this.game) return json({error:'방을 찾을 수 없어요.'},404);
      if(this.game.players.length>=8) return json({error:'이미 8명이 입장했어요.'},409);
      const {member,mode}=await request.json();
      if((this.game.mode||'poker')!==mode) return json({error:'다른 종류의 게임 방이에요. 올바른 초대 링크를 열어주세요.'},409);
      const used=new Set(this.game.players.map(p=>p.seat));
      const seat=Array.from({length:8},(_,i)=>i).find(n=>!used.has(n));
      this.game.players.push(this.game.mode==='blackjack'?makeBlackjackPlayer(member,seat):makePlayer(member,seat));
      if(!this.game.players.some(p=>p.id===this.game.hostId)) this.game.hostId=member.id;
      await this.persist();this.broadcast();return json({ok:true},201);
    }
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket') return json({error:'WebSocket으로 접속해 주세요.'},426);
    if(!this.game) return json({error:'존재하지 않는 방이에요.'},404);
    const u=new URL(request.url),playerId=u.searchParams.get('pid'),auth=u.searchParams.get('token');
    const p=this.game.players.find(p=>p.id===playerId);
    if(!p||p.auth!==auth) return json({error:'인증에 실패했어요. 방에 다시 입장해 주세요.'},401);
    // Only one active connection for each authenticated seat.
    for(const old of this.ctx.getWebSockets()) if(old.deserializeAttachment()?.playerId===playerId){
      try{old.close(4000,'다른 창에서 재접속했습니다.');}catch{}
    }
    const sockets=new WebSocketPair(),client=sockets[0],server=sockets[1];
    this.ctx.acceptWebSocket(server);server.serializeAttachment({playerId});
    this.send(server,view(this.game,playerId,onlineIds(this.ctx)));
    this.broadcast();
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws,message){
    await this.ready;
    if(message==='ping') return;
    if(typeof message!=='string'||message.length>1024){this.send(ws,{type:'error',error:'메시지 크기가 초과되었어요.'});return;}
    let data;try{data=JSON.parse(message);}catch{return;}
    const playerId=ws.deserializeAttachment()?.playerId;
    if(!this.game?.players.some(p=>p.id===playerId)) return;
    // Serialize game mutations for all clients sharing this room.
    await this.ctx.blockConcurrencyWhile(async()=>{
      const g=this.game,p=g.players.find(p=>p.id===playerId);
      try{
        if(data.type==='chat'){
          const text=String(data.text||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,180);
          if(!text) return;
          if(p.lastChat && Date.now()-p.lastChat<850) throw Error('채팅은 잠깐 간격을 두고 보내 주세요.');
          p.lastChat=Date.now();g.chat.push({id:randomHex(5),name:p.name,text,time:Date.now()});g.chat=g.chat.slice(-30);
        } else if(data.type==='start'){
          if(g.hostId!==playerId) throw Error('방장만 다음 게임을 시작할 수 있어요.');
          if(g.mode==='blackjack') {
            if(data.expectHand!==g.hand) throw Error('이미 다음 라운드가 진행됐어요.');
            await blackjackStart(g,onlineIds(this.ctx));
          }
          else await startHand(g,onlineIds(this.ctx));
        } else if(data.type==='act'){
          const opId=typeof data.opId==='string'?data.opId:'';
          if(!/^[A-Za-z0-9_-]{8,64}$/.test(opId)) throw Error('잘못된 행동 요청이에요.');
          if(p.ops.includes(opId)) return;
          if(g.mode==='blackjack') {
            if(data.hand!==g.hand || data.handIndex!==g.handIndex) throw Error('이전 라운드 또는 다른 손패의 행동 요청이에요.');
            blackjackAction(g,playerId,data.action);
          }
          else act(g,playerId,data.action,data.to);
          p.ops.push(opId);p.ops=p.ops.slice(-32);
        } else if(data.type==='bet' && g.mode==='blackjack'){
          blackjackSetBet(g,playerId,data.amount);
        } else if(data.type==='rebuy'){
          if(!['lobby',g.mode==='blackjack'?'result':'showdown'].includes(g.stage)) throw Error('라운드가 끝난 뒤 칩을 다시 받을 수 있어요.');
          if(p.chips>=(g.mode==='blackjack'?10:1)) throw Error('칩을 모두 사용한 후 다시 받을 수 있어요.');
          p.chips=1000;
          if(g.mode==='blackjack')p.nextBet=20;
        } else if(data.type==='leave'){
          if(!['lobby',g.mode==='blackjack'?'result':'showdown'].includes(g.stage)) throw Error('게임 도중에는 나갈 수 없어요.');
          g.players=g.players.filter(q=>q.id!==playerId);
          if(g.hostId===playerId) g.hostId=g.players.find(q=>onlineIds(this.ctx).has(q.id))?.id || g.players[0]?.id || null;
          this.send(ws,{type:'left'});
        } else if(data.type==='kick'){
          if(g.hostId!==playerId) throw Error('방장만 퇴장시킬 수 있어요.');
          if(!['lobby',g.mode==='blackjack'?'result':'showdown'].includes(g.stage)) throw Error('게임 도중에는 좌석을 비울 수 없어요.');
          const target=g.players.find(q=>q.id===data.playerId);
          if(!target||target.id===playerId) throw Error('유효하지 않은 퇴장 대상이에요.');
          if(onlineIds(this.ctx).has(target.id)) throw Error('접속 중인 사람은 퇴장시킬 수 없어요.');
          g.players=g.players.filter(q=>q.id!==target.id);
        } else throw Error('알 수 없는 요청이에요.');
        await this.persist();this.broadcast();
      }catch(err){this.send(ws,{type:'error',error:err.message||'처리에 실패했어요.'});}
    });
  }
  async webSocketClose(ws){
    await this.ready;
    const g=this.game;if(!g) return;
    const hostOnline=onlineIds(this.ctx).has(g.hostId);
    if(!hostOnline){
      const replacement=g.players.find(p=>onlineIds(this.ctx).has(p.id));
      if(replacement) {g.hostId=replacement.id;await this.persist();}
    }
    this.broadcast();
  }
  async webSocketError(ws){try{ws.close(1011,'연결 오류');}catch{} this.broadcast();}
  async alarm(){
    await this.ready;
    await this.ctx.blockConcurrencyWhile(async()=>{
      const g=this.game;
      if(!g||!g.turnId||!g.deadline||Date.now()<g.deadline) return;
      const id=g.turnId,allowed=g.mode==='blackjack'?blackjackLegal(g,id):legal(g,id);
      if(!allowed) return;
      if(g.mode==='blackjack') blackjackAction(g,id,'stand');
      else act(g,id,allowed.toCall===0?'check':'fold');
      await this.persist();this.broadcast();
    });
  }
}
