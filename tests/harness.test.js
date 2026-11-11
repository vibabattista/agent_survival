// Run with: node --test tests/harness.test.js (no model calls or API credits).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor(){this.children=[];this.value='';this.style={};this.textContent='';this.className='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
}
const person = (name, location, apples=0) => ({name, location, apples, travel:null, health:100, energy:100, food:100, goal:'survive', memories:[]});

function makeLab(agents, respond, overrides={}, oldServer=false){
  const elements=new Map();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();}};
  const initial={day:1,tick:0,settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:0},provider:'openai',model:'test-model',reasoningEffort:'none',storage:0,ground:{shelter:0,woods:0},agents,events:[],chronicles:[],...overrides};
  const values=new Map();let savedState=structuredClone(initial);const savedRaw=[];
  const localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const calls=[];
  const fetch=async(url,options={})=>{
    if(url==='/api/capabilities')return {ok:!oldServer,json:async()=>({features:oldServer?[]:['worldFrames']})};
    if(url==='/api/experiment')return {ok:true,json:async()=>({current:savedState,rawRequests:[]})};
    if(url==='/api/recall'){const request=JSON.parse(options.body),agent=savedState.agents[request.agentIndex],matches=(agent.experiences||[]).filter(e=>e.day<request.beforeDay&&e.text.toLowerCase().includes(request.query.toLowerCase()));return {ok:true,json:async()=>({results:matches.slice(request.offset,request.offset+10),hasMore:matches.length>request.offset+10,nextOffset:request.offset+10})};}
    if(url==='/api/state'){savedState=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true})};}
    if(url==='/api/commit'){const payload=JSON.parse(options.body),next=payload.state;for(const c of payload.append){const previous=c.scope==='world'?savedState:savedState.agents[Number(c.scope)],target=c.scope==='world'?next:next.agents[Number(c.scope)];assert.equal((previous[c.kind]||[]).length,c.expected);target[c.kind]=[...(previous[c.kind]||[]),...c.items];}savedState=next;return {ok:true,json:async()=>({ok:true})};}
    if(url==='/api/raw'){savedRaw.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};}
    const request=JSON.parse(options.body);calls.push(request);const answer=respond(request);return {ok:true,json:async()=>({text:typeof answer==='string'?answer:JSON.stringify(answer),usage:{}})};
  };
  const context={document,localStorage,fetch,structuredClone,console,Math,JSON,Blob,URL,setTimeout,confirm:()=>true};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','lab.js'),'utf8'),context);
  const ready=new Promise(resolve=>setTimeout(resolve,0));
  const getSaved=()=>({history:[savedState],cursor:0});
  return {calls,elements,getSaved,ready,async tick(){await ready;await elements.get('step').onclick();return structuredClone(savedState);}};
}
const named = request => (request.input.match(/\n\nYou are (\w+)/)||[])[1];

test('senses include own inventory, nearby people and only local actions',async()=>{
  const mara=person('Mara','shelter',2),kit=person('Kit','shelter'),rowan=person('Rowan','woods');
  mara.memories.push('OLD UNVERIFIED WOODS MEMORY');
  const lab=makeLab([mara,kit,rowan],()=>({action:'wait',memory:''}));await lab.tick();
  const call=lab.calls.find(c=>named(c)==='Mara');
  assert.match(call.input,/"heldApples":2/);assert.match(call.input,/"nearby":\["Kit"\]/);
  assert.doesNotMatch(call.input,/OLD UNVERIFIED WOODS MEMORY|snake|monster|\btree\b/i);
  assert.ok(call.allowed_actions.includes('speak'));assert.ok(!call.allowed_actions.includes('search'));
  assert.ok(!call.allowed_actions.includes('take')); // empty storage
});

test('an old server is detected before any model requests or experiment changes',async()=>{
  const lab=makeLab([person('Mara','shelter')],()=>({action:'wait'}),{},true);await lab.ready;
  assert.match(lab.elements.get('status').textContent,/server is out of date/i);
  assert.equal(lab.elements.get('step').disabled,true);assert.equal(lab.calls.length,0);
  assert.equal(lab.getSaved().history[0].tick,0);
});

test('recorded event replay shows actual location and energy at that moment',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter')],req=>named(req)==='Mara'?{action:'travel',target:'woods',pace:'medium',thought:'Heading out',memory:''}:{action:'wait',thought:'',memory:''});
  const state=await lab.tick();const event=state.events.find(e=>e.text.includes('Mara travels towards woods'));
  const frame=state.worldFrames[event.frameIndex];assert.equal(frame.agents[0].travel.to,'woods');assert.equal(frame.agents[0].energy,70);assert.equal(frame.agents[1].location,'shelter');
  const group=lab.elements.get('story-stream').children[0],card=group.children.find(c=>c.children.some(x=>x.textContent===event.text));card.onclick();
  assert.match(lab.elements.get('replay-label').textContent,/recorded moment/);
  const travelZone=lab.elements.get('map').children[1],avatar=travelZone.children[1].children[0];assert.equal(avatar.children[2].textContent,'Mara');
  const energyRow=avatar.children[0].children[1];assert.equal(energyRow.children[3].textContent,'-30');
  const finalFrame=state.worldFrames.find(f=>f.day===1&&f.tick===1&&f.phase==='end');assert.ok(finalFrame);
});

test('an older event without a recorded frame never displays current state as history',async()=>{
  const lab=makeLab([person('Mara','shelter')],()=>({action:'wait'}),{tick:1,events:[{day:1,tick:1,kind:'action',text:'Mara did something earlier.'}]});
  await lab.ready;const group=lab.elements.get('story-stream').children[0],card=group.children.find(c=>c.children.some(x=>x.textContent==='Mara did something earlier.'));card.onclick();
  assert.match(lab.elements.get('replay-label').textContent,/unavailable/);assert.match(lab.elements.get('map').children[0].textContent,/not saved/);
});

test('replay shows the selected speaker’s complete words without duplicating unchanged world frames',async()=>{
  const line='Please follow me. '.repeat(12);
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter')],req=>req.response_format==='conversation'?{speech:'I hear you',choice:'end',memory:''}:named(req)==='Mara'?{action:'speak',target:'Bea',speech:line,thought:'',memory:''}:{action:'wait',thought:'',memory:''});
  const state=await lab.tick();const spoken=state.events.find(e=>e.kind==='dialogue'&&e.text.includes(line));
  const group=lab.elements.get('story-stream').children[0],card=group.children.find(c=>c.children.some(x=>x.textContent===spoken.text));card.onclick();
  const shelter=lab.elements.get('map').children[0],mara=shelter.children[1].children.find(a=>a.children[2].textContent==='Mara');
  assert.equal(mara.children[3].textContent,line.trim());
  assert.equal(state.worldFrames.length,2); // initial state and end of tick; speech changes neither
});

test('rejects an unsupported action without advancing the tick',async()=>{
  const lab=makeLab([person('Mara','shelter')],()=>({action:'search',memory:''}));const state=await lab.tick();
  assert.equal(state.tick,0);assert.match(lab.elements.get('status').textContent,/unavailable action/);
});

test('accepts repeated identical JSON while preserving the full response',async()=>{
  const object=JSON.stringify({action:'rest',thought:'A {curious} thought',memory:'',recall_query:''});
  const lab=makeLab([person('Mara','shelter')],()=>object+'\n} (extra text)\n'+object);
  const state=await lab.tick();assert.equal(state.tick,1);
  assert.ok(state.events.some(e=>e.kind==='warning'&&e.text.includes('duplicated matching JSON')));
  assert.ok(state.events.some(e=>e.text==='Mara rested.'));
});

test('rejects conflicting or incomplete JSON instead of choosing an action',async()=>{
  const a=JSON.stringify({action:'rest'}),b=JSON.stringify({action:'wait'});
  const lab=makeLab([person('Mara','shelter')],()=>a+'\n'+b);
  const state=await lab.tick();assert.equal(state.tick,0);
  assert.match(lab.elements.get('status').textContent,/invalid or conflicting JSON/);
  const incomplete=makeLab([person('Mara','shelter')],()=>'{"action":"rest"');
  assert.equal((await incomplete.tick()).tick,0);
});

test('a remote speech target is rejected without sending a reply',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Kit','shelter'),person('Rowan','woods')],()=>({action:'speak',target:'Rowan',speech:'hello',memory:''}));
  const state=await lab.tick();assert.equal(state.tick,0);assert.match(lab.elements.get('status').textContent,/outside their reach/);
  assert.equal(lab.calls.length,1);
});

test('ungrounded speech is allowed and flagged; remote person does not hear it',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter'),person('Kit','woods')],request=>{
    if(request.response_format==='conversation')return {speech:'I hear you.',memory:'Mara asked me.',choice:'end',effort:0};
    return named(request)==='Mara'?{action:'speak',target:'Bea',speech:'I will search the shelter, check your leg and shout to Kit.',memory:'I treated the wound.'}:{action:'wait',memory:''};
  });
  const state=await lab.tick();assert.equal(state.tick,1);
  assert.ok(state.events.some(e=>e.kind==='warning'&&e.text.includes('body part')));
  assert.ok(state.events.some(e=>e.kind==='warning'&&e.text.includes('shelter-search')));
  assert.ok(state.events.some(e=>e.kind==='warning'&&e.text.includes('outside hearing range')));
  assert.ok(state.agents[1].experiences.some(x=>x.text.includes('check your leg')));
  assert.ok(!(state.agents[2].experiences||[]).some(x=>x.text.includes('check your leg')));
  assert.ok(state.agents[0].experiences.some(x=>x.kind==='unverified impression'&&x.text==='I treated the wound.'));
});

test('an agent departing on the same tick cannot hear the conversation',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter')],request=>{
    if(request.response_format==='reply')return {speech:'hello',memory:''};
    return named(request)==='Mara'?{action:'speak',target:'Bea',speech:'secret words',memory:''}:{action:'travel',target:'woods',pace:'fast',memory:''};
  });
  const state=await lab.tick();assert.equal(state.tick,1);
  assert.ok(state.events.some(e=>e.text.includes('speak to someone unavailable')));
  assert.ok(!(state.agents[1].experiences||[]).some(x=>x.text.includes('secret words')));
  assert.ok(!lab.calls.some(c=>c.response_format==='conversation'));
});

test('conversation replies do not see a person who is departing that tick',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter'),person('Kit','shelter')],request=>{
    if(request.response_format==='conversation')return {speech:'hello',memory:'',choice:'end',effort:0};
    if(named(request)==='Mara')return {action:'speak',target:'Bea',speech:'hello',memory:''};
    if(named(request)==='Kit')return {action:'travel',target:'woods',pace:'fast',memory:''};
    return {action:'wait',memory:''};
  });
  const state=await lab.tick();assert.equal(state.tick,1);
  const reply=lab.calls.find(c=>c.response_format==='conversation');assert.ok(reply);
  assert.doesNotMatch(reply.input,/"nearby":\[[^\]]*"Kit"/);
  assert.ok(!(state.agents[2].experiences||[]).some(x=>x.text.includes('hello')));
});

test('the tree is visible only after entering the woods, not its hidden hazards or odds',async()=>{
  const lab=makeLab([person('Mara','woods')],()=>({action:'wait',memory:''}));await lab.tick();
  const request=lab.calls[0];assert.ok(request.allowed_actions.includes('search'));
  assert.match(request.input,/"search":\{"target":"tree"\}/);
  assert.doesNotMatch(request.input,/snake|shadow monster|snakeDamage|daySnake|nightSnake/i);
});

test('witnessed facts and model impressions stay distinguishable',async()=>{
  const mara=person('Mara','shelter');mara.experiences=[{day:1,tick:0,kind:'observation',text:'Mara ate an apple.'},{day:1,tick:0,kind:'unverified impression',text:'I think Bea might help.'}];
  const lab=makeLab([mara,person('Bea','shelter')],()=>({action:'wait',memory:''}));await lab.tick();
  assert.match(lab.calls[0].input,/"observation","Mara ate an apple\."/);
  assert.match(lab.calls[0].input,/"unverified impression","I think Bea might help\."/);
});

test('today’s full ordered experience stays private; older dialogue remains in the record',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','woods');
  mara.experiences=Array.from({length:80},(_,i)=>({day:1,tick:i,kind:'observation',text:`Mara observation ${i}`}));
  mara.experiences.unshift({day:0,tick:3,kind:'speech',text:'Mara says to Bea: “Old private conversation.”'});
  bea.experiences=[{day:1,tick:1,kind:'private stated thought',text:'BEA PRIVATE THOUGHT'}];
  const lab=makeLab([mara,bea],()=>({action:'wait',thought:'',memory:''}));const state=await lab.tick();
  const prompt=lab.calls.find(c=>named(c)==='Mara').input;
  assert.ok(prompt.includes('Mara observation 0')&&prompt.includes('Mara observation 79'));
  assert.ok(prompt.indexOf('Mara observation 0')<prompt.indexOf('Mara observation 79'));
  assert.ok(!prompt.includes('Old private conversation.'));assert.ok(!prompt.includes('BEA PRIVATE THOUGHT'));
  assert.ok(state.agents[0].experiences.some(e=>e.text.includes('Old private conversation.')));
  assert.ok(state.agents[0].experiences.some(e=>e.text==='Mara observation 0'));assert.ok(state.agents[0].experiences.length>80);
});

test('conversation can continue for multiple messages and ends when an agent chooses',async()=>{
  let turns=0;
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter'),person('Kit','woods')],req=>{
    if(req.response_format==='conversation'){turns++;return {speech:`response ${turns}`,memory:'',choice:turns===1?'continue':'end',effort:0};}
    return named(req)==='Mara'?{action:'speak',target:'Bea',speech:'opening',thought:'PRIVATE PLAN',memory:''}:{action:'wait',thought:'',memory:''};
  });
  const state=await lab.tick();assert.equal(turns,2);
  const speech=state.events.filter(e=>e.kind==='dialogue').map(e=>e.text);
  assert.equal(speech.length,3);assert.ok(speech[0].includes('opening'));assert.ok(speech[2].includes('response 2'));
  assert.ok(!(state.agents[1].experiences||[]).some(e=>e.text.includes('PRIVATE PLAN')));
  assert.ok(!(state.agents[2].experiences||[]).some(e=>e.text.includes('opening')));
});

test('an agent can look up its own earlier dialogue without spending its action',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','shelter');
  mara.experiences=[{day:1,tick:4,kind:'speech',text:'Bea says to Mara: “I saved you an apple.”'}];
  bea.experiences=[{day:1,tick:4,kind:'private stated thought',text:'BEA PRIVATE SECRET'}];
  let searched=false;
  const lab=makeLab([mara,bea],req=>{
    if(named(req)==='Mara'&&!searched){searched=true;return {action:'wait',recall_query:'apple',recall_offset:0,thought:'',memory:''};}
    if(named(req)==='Mara'){assert.ok(req.input.includes('I saved you an apple.'));assert.ok(!req.input.includes('BEA PRIVATE SECRET'));return {action:'rest',recall_query:'',thought:'',memory:''};}
    return {action:'wait',recall_query:'',thought:'',memory:''};
  },{day:2});
  const state=await lab.tick();assert.ok(state.events.some(e=>e.text==='Mara rested.'));
});

test('an agent may update its private notebook and choose to spend a tick thinking',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','shelter');
  const lab=makeLab([mara,bea],req=>named(req)==='Mara'?{action:'think',thought:'Plan for food',memory:'',notebook_operation:'replace',notebook:'Kit shared food',recall_query:''}:{action:'wait',thought:'',memory:''});
  const state=await lab.tick();assert.equal(state.agents[0].notebook,'Kit shared food');
  assert.ok(state.events.some(e=>e.text==='Mara spent the tick thinking.'));
  assert.ok(!lab.calls.find(c=>named(c)==='Bea').input.includes('Kit shared food'));
});

test('the notebook is recalled only on request',async()=>{
  const mara=person('Mara','shelter');mara.notebook='Kit gave me an apple.\n\nA second detailed note.';
  let searched=false;
  const lab=makeLab([mara],req=>{
    if(!searched){searched=true;assert.ok(!req.input.includes('Kit gave me an apple.'));return {action:'wait',recall_query:'Kit',recall_source:'notebook',recall_offset:0,thought:'',memory:''};}
    assert.ok(req.input.includes('Kit gave me an apple.'));assert.ok(!req.input.includes('A second detailed note.'));
    return {action:'wait',recall_query:'',thought:'',memory:''};
  });
  await lab.tick();assert.equal(lab.calls.length,2);
});

test('lookup limit is applied per agent per tick and the final call can still act',async()=>{
  const mara=person('Mara','shelter');mara.notebook='An apple';let calls=0;
  const lab=makeLab([mara],req=>{calls++;return {action:'rest',recall_query:calls<=3?'apple':'',recall_source:'notebook',recall_offset:0,thought:'',memory:''};});
  const state=await lab.tick();assert.equal(calls,4);assert.equal(lab.calls.at(-1).allow_recall,false);assert.ok(state.events.some(e=>e.text==='Mara rested.'));
});

test('an oversized notebook is reorganised by its agent before the next decision',async()=>{
  const mara=person('Mara','shelter');mara.notebook='Long notebook about Kit';
  const lab=makeLab([mara],req=>req.response_format==='notebook_organise'?{notebook:'Trust Kit'}:{action:'wait',thought:'',memory:'',recall_query:''},{settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:0,maxNotebookChars:10}});
  const state=await lab.tick();assert.equal(state.agents[0].notebook,'Trust Kit');assert.equal(lab.calls[0].response_format,'notebook_organise');
});

test('a failed notebook reorganisation preserves the saved notebook and does not advance the tick',async()=>{
  const mara=person('Mara','shelter');mara.notebook='Long notebook about Kit';
  const lab=makeLab([mara],()=>({notebook:'Still much too long'}),{settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:0,maxNotebookChars:10}});
  const state=await lab.tick();assert.equal(state.tick,0);assert.equal(state.agents[0].notebook,'Long notebook about Kit');
  assert.match(lab.elements.get('status').textContent,/prior notebook is preserved/);
});

test('overnight reflections receive only each agent’s own complete experiences',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','shelter');
  mara.experiences=[{day:1,tick:2,kind:'private stated thought',text:'MARA SECRET'}];
  bea.experiences=[{day:1,tick:3,kind:'private stated thought',text:'BEA SECRET'}];
  const lab=makeLab([mara,bea],req=>req.response_format==='reflection'?{summary:'my day',deductions:'my belief',future_intentions:'my plan',notebook_operation:'append',notebook:'Plans for tomorrow'}:req.response_format==='text'?'chronicle':{action:'wait',thought:'',memory:''},{tick:23});
  const state=await lab.tick();assert.equal(state.tick,24);
  const mr=lab.calls.find(c=>c.response_format==='reflection'&&named(c)==='Mara');
  const br=lab.calls.find(c=>c.response_format==='reflection'&&named(c)==='Bea');
  assert.ok(mr&&br);assert.ok(mr.input.includes('MARA SECRET'));assert.ok(!mr.input.includes('BEA SECRET'));
  assert.equal(mr.input.split('MARA SECRET').length-1,1);
  assert.ok(br.input.includes('BEA SECRET'));assert.ok(!br.input.includes('MARA SECRET'));
  assert.equal(state.agents[0].dailyReflections[0].deductions,'my belief');
  assert.equal(state.agents[0].notebook,'Plans for tomorrow');
  assert.ok(state.agents[0].experiences.some(e=>e.text==='MARA SECRET'));
});

test('the shadow monster strikes at most one outdoor person per night tick',async()=>{
  const lab=makeLab([person('Mara','woods'),person('Bea','woods'),person('Kit','shelter')],()=>({action:'wait',thought:'',memory:''}),{tick:12,settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:100,shadowDamage:40}});
  const state=await lab.tick();
  assert.equal(state.events.filter(e=>e.kind==='danger'&&e.text.includes('shadow monster')).length,1);
  assert.equal(state.agents[0].health+state.agents[1].health,160);
  assert.equal(state.agents[2].health,100);
});

test('arrival at shelter makes an agent safe from the shadow monster that tick',async()=>{
  const rowan=person('Rowan','woods');rowan.health=20;rowan.travel={from:'woods',to:'shelter',remaining:1};
  const lab=makeLab([rowan,person('Bea','woods')],()=>({action:'wait',thought:'',memory:''}),{tick:12,settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:100,shadowDamage:40}});
  const state=await lab.tick();
  assert.equal(state.agents[0].health,20);assert.equal(state.agents[0].location,'shelter');
  assert.equal(state.agents[1].health,60);
});

test('the shadow monster cannot attack when everyone is in shelter',async()=>{
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter')],()=>({action:'wait',thought:'',memory:''}),{tick:12,settings:{dayTicks:12,nightTicks:12,foodLoss:0,shadowChance:100,shadowDamage:40}});
  const state=await lab.tick();
  assert.equal(state.events.filter(e=>e.kind==='danger'&&e.text.includes('shadow monster')).length,0);
  assert.deepEqual(state.agents.map(a=>a.health),[100,100]);
});

test('two lethal attacks chosen on the same tick both resolve',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','shelter');mara.health=10;bea.health=10;
  const lab=makeLab([mara,bea],req=>req.response_format==='defence'?{defence:0,speech:'',memory:''}:{action:'attack',target:named(req)==='Mara'?'Bea':'Mara',effort:20,thought:'',memory:''});
  const state=await lab.tick();assert.equal(state.agents[0].health,0);assert.equal(state.agents[1].health,0);
  assert.equal(state.events.filter(e=>e.kind==='death').length,2);
  assert.equal(state.events.filter(e=>e.kind==='action'&&e.text.includes('damage 20')).length,2);
});

test('defence receives the defender’s own structured perspective, not another agent’s thoughts',async()=>{
  const mara=person('Mara','shelter'),bea=person('Bea','shelter');
  bea.experiences=[{day:1,tick:0,kind:'private stated thought',text:'BEA REMEMBERS MARA'}];
  mara.experiences=[{day:1,tick:0,kind:'private stated thought',text:'MARA SECRET'}];
  const lab=makeLab([mara,bea],req=>req.response_format==='defence'?{defence:0,speech:'',memory:''}:named(req)==='Mara'?{action:'attack',target:'Bea',effort:5,thought:'',memory:''}:{action:'wait',thought:'',memory:''});
  await lab.tick();const prompt=lab.calls.find(c=>c.response_format==='defence').input;
  assert.match(prompt,/SENSES\n/);assert.match(prompt,/INTERNAL\n/);assert.match(prompt,/ACTIONS\n/);
  assert.ok(prompt.includes('BEA REMEMBERS MARA'));assert.ok(!prompt.includes('MARA SECRET'));
});

test('competing ground pickups negotiate instead of duplicating or favouring the first',async()=>{
  const lab=makeLab([person('Mara','woods'),person('Bea','woods')],req=>{
    if(req.response_format==='dispute')return {choice:named(req)==='Mara'?'yield':'insist',target:'',effort:0,speech:'decision'};
    return {action:'pick_up',thought:'',memory:''};
  },{ground:{shelter:0,woods:1}});
  const state=await lab.tick();assert.equal(state.ground.woods,0);assert.equal(state.agents[0].apples,0);assert.equal(state.agents[1].apples,1);
});

test('competing agents can both fight and a single apple is not duplicated',async()=>{
  const mara=person('Mara','woods'),bea=person('Bea','woods');mara.health=10;bea.health=10;
  const lab=makeLab([mara,bea],req=>{
    if(req.response_format==='dispute')return {choice:'attack',target:named(req)==='Mara'?'Bea':'Mara',effort:20,speech:'I need it'};
    if(req.response_format==='defence')return {defence:0,speech:'',memory:''};
    return {action:'pick_up',thought:'',memory:''};
  },{ground:{shelter:0,woods:1}});
  const state=await lab.tick();assert.equal(state.ground.woods,1);assert.equal(state.agents[0].apples+state.agents[1].apples,0);
  assert.equal(state.agents[0].health,0);assert.equal(state.agents[1].health,0);
});

test('full spoken messages are retained in the witness history',async()=>{
  const text='Long conversation. '.repeat(40);
  const lab=makeLab([person('Mara','shelter'),person('Bea','shelter')],req=>{
    if(req.response_format==='conversation')return {speech:'understood',memory:'',choice:'end',effort:0};
    return named(req)==='Mara'?{action:'speak',target:'Bea',speech:text,thought:'',memory:''}:{action:'wait',thought:'',memory:''};
  });
  const state=await lab.tick();assert.ok(state.agents[1].experiences.some(e=>e.kind==='speech'&&e.text.includes(text)));
});

test('a failed reflection is logged and does not block the next day',async()=>{
  const lab=makeLab([person('Mara','shelter')],req=>{
    if(req.response_format==='reflection')throw Error('model unavailable');
    if(req.response_format==='text')return 'chronicle';
    return {action:'wait',thought:'my thought',memory:''};
  },{tick:23});
  let state=await lab.tick();assert.equal(state.tick,24);assert.ok(state.events.some(e=>e.kind==='warning'&&e.text.includes('reflection')));
  state=await lab.tick();assert.equal(state.day,2);assert.equal(state.tick,1);
});
