'use strict';
/* data: static game data — nodes, edges, geography DLC, characters, moods and the event deck; builds the world graph. */
/* ================= THE COMPLETE EVIDENCE BOARD — 70 exhibits · +12 with the GEOGRAPHY DLC ================= */
const BASE_NODES=[
{id:'citi',image:'./static/citi tower.webp',name:['CITI TOWER'],icon:'🏦',type:'BANK',shape:'logo',band:'#1a5fa8',income:3,cost:8,x:210,y:150,rot:-2,sub:'too big to fail · 007 on payroll',sp:'+$1 income per CORPORATE node you own (James Bond is on the payroll).'},
{id:'commbank',image:'./static/cba.png',name:['COMMONWEALTH BANK'],icon:'🏦',type:'BANK',shape:'logo',band:'#d4a017',income:2,cost:6,x:400,y:95,rot:2,sub:'can’t be beat? we’ll see',sp:'+$2 income while you own any other BANK (the big four stick together).'},
{id:'nab',image:'./static/nab.png',name:['NAB'],icon:'🏦',type:'BANK',shape:'logo',band:'#c0392b',income:2,cost:6,x:590,y:165,rot:-1,sub:'more than money',sp:'Seizing CHART nodes costs you $1 less (their analysts share screens).'},
{id:'anz',image:'./static/anz.png',name:['ANZ'],icon:'🏦',type:'BANK',shape:'logo',band:'#2e7d64',income:2,cost:6,x:770,y:100,rot:2,sub:'the blue bank',sp:'+$1 income per CHART node you own (ANZ reads the data).'},
{id:'westpac',image:'./static/westpac.png',name:['WESTPAC'],icon:'🏦',type:'BANK',shape:'logo',band:'#d21e2b',income:2,cost:6,x:500,y:270,rot:1,sub:'the red bank · the other fourth',sp:'+$1 income per REGULATOR you own (they have sat through every inquiry).'},
{id:'bond',image:'./static/bond desk.png',name:['THE BOND DESK'],icon:'💼',type:'BANK',income:3,cost:8,x:1040,y:310,rot:1,sub:'“Government Bond: the collapse of the world’s safest investment.”',sp:'Gain 2 Intel when you seize it. Collects the tolls when BONDMAGEDDON.'},
{id:'hedge',image:'./static/hedge fund.png',name:['THE HEDGE FUND'],icon:'🕶️',type:'BANK',income:2,cost:6,x:1260,y:300,rot:-2,sub:'somebody’s shorting',sp:'+$3 whenever ANY player is raided — even you.'},
{id:'rba',image:'./static/rba.png',name:['RESERVE BANK','OF AUSTRALIA'],icon:'🏛️',type:'REGULATOR',shape:'logo',band:'#4a5a66',income:2,cost:10,x:960,y:145,rot:1,sub:'sets the price of money',sp:'−1 Cortisol at the start of each of your turns. The cash rate is whatever you say it is. Hostile takeovers stay at list price forever.'},
{id:'asic',image:'./static/asic.png',name:['ASIC'],icon:'⚖️',type:'REGULATOR',shape:'logo',band:'#1f3a5f',income:1,cost:5,x:1160,y:95,rot:-1,sub:'the corporate cop',sp:'Unlocks AUDIT ($4): any rival +1 Cortisol, once per turn.'},
{id:'accc',image:'./static/accc.png',name:['ACCC'],icon:'🧐',type:'REGULATOR',shape:'logo',band:'#233a8f',income:1,cost:5,x:1360,y:155,rot:1,sub:'reviews every merger',sp:'When a rival hostile-takes one of YOUR nodes, they pay you an extra $2 (ACCC review fee).'},
{id:'gov',image:'./static/coat of arms.png',name:['AUSTRALIAN GOVERNMENT','COAT OF ARMS'],icon:'🦘',type:'REGULATOR',shape:'logo',band:'#1b3a2a',income:2,cost:8,x:1540,y:100,rot:-1,sub:'documents, logos & ribbons',sp:'Unlocks BUDGET NIGHT ($3): every rival pays you $1 and you gain +1 Intel.'},
/* — charts pinned across the collage, not stacked in one corner — */
{id:'us',image:'./static/us treasury yield.png',name:['US BOND','YIELDS'],type:'CHART',shape:'chart',spark:'up',income:0,cost:2,x:1980,y:95,rot:1,sub:'the safe haven',sp:'+$1 while you own the 10-YEAR MASTER CHART; +$1 on BONDMAGEDDON; +$2 on TRUMP TWEETS TARIFFS.'},
{id:'japan',image:'./static/debt japan.png',name:['JAPAN BOND','YIELDS'],type:'CHART',shape:'chart',spark:'up',income:0,cost:2,x:2260,y:455,rot:-1,sub:'largest foreign holder, allegedly',sp:'+$1 while you own the MASTER CHART; +$3 on BONDMAGEDDON (curve control fails).'},
{id:'uk',image:'./static/uk bond yield.png',name:['UK BOND','YIELDS'],type:'CHART',shape:'chart',spark:'up',income:0,cost:2,x:980,y:1165,rot:1,sub:'gilts gone wild',sp:'+$1 while you own the MASTER CHART; +$1 on BONDMAGEDDON.'},
{id:'aus',image:'./static/aus bond yield.png',name:['AUSTRALIAN','BOND YIELDS'],type:'CHART',shape:'chart',spark:'up',income:0,cost:2,x:1325,y:85,rot:1,sub:'home soil',sp:'+$1 while you own the MASTER CHART; +$1 on BONDMAGEDDON.'},
{id:'tenyear',image:'./static/government bond comparison.png',name:['10-YEAR GOVT','BOND YIELDS'],type:'CHART',shape:'chart',spark:'up',income:1,cost:4,x:1285,y:205,rot:1,sub:'the master chart — now in the middle of everything',sp:'THE MASTER CHART: +$3 income for every other CHART node you own.'},
{id:'infl',image:'./static/inflation data.png',name:['INFLATION','COMPENSATION'],type:'CHART',shape:'chart',spark:'up',income:1,cost:3,x:1085,y:675,rot:-1,sub:'the hidden tax',sp:'Your salary is $4, not $3 — indexed to CPI.'},
{id:'cash',image:'./static/cash rate graph.png',name:['CASH-RATE','CHART'],type:'CHART',shape:'chart',spark:'step',income:1,cost:3,x:880,y:210,rot:1,sub:'the RBA headline',sp:'+$2 whenever the RBA CASH-RATE DECISION is drawn (you set it).'},
{id:'stock',image:'./static/stock market graph.png',name:['STOCK-MARKET','CHARTS'],type:'CHART',shape:'chart',spark:'vola',income:1,cost:3,x:1365,y:365,rot:1,sub:'green days, red days',sp:'+$1 while you own THE TERMINAL or FOX BUSINESS (fast data).'},
/* — the commodities — */
{id:'oil',image:'./static/wti crude.png',name:['CRUDE OIL PIT','WTI · USD/BBL'],icon:'🛢️',type:'COMMODITY',income:8,cost:12,x:1500,y:470,rot:-2,sub:'the ticker that never sleeps',sp:'Pays $8 a turn. $6 windfall whenever OIL SPIKES is drawn.'},
{id:'oilgraph',image:'./static/oil price increase.png',name:['OIL PRICE','INCREASE'],type:'COMMODITY',shape:'chart',spark:'up',income:1,cost:3,x:1680,y:540,rot:2,sub:'the graph that called it',sp:'+$2 whenever OIL SPIKES (you drew the graph).'},
{id:'barrels',image:'./static/blue oil barrels.png',name:['BLUE OIL','BARRELS'],icon:'🛢️',type:'COMMODITY',income:2,cost:4,x:1320,y:480,rot:1,sub:'stacked and photographed',sp:'+$1 income while you own THE FORKLIFT.'},
{id:'tanker',image:'./static/tanker fleet.png',name:['THE TANKER FLEET'],icon:'🚢',type:'COMMODITY',income:2,cost:5,x:1850,y:430,rot:2,sub:'coal & crude by sea',sp:'+$3 on OIL SPIKES or COAL RUSH.'},
{id:'petronas',image:'./static/petronas.png',name:['PETRONAS'],icon:'🛢️',type:'COMMODITY',shape:'logo',band:'#00a19b',income:3,cost:7,x:2000,y:530,rot:-1,sub:'the national oil company',sp:'+$3 on OIL SPIKES.'},
{id:'gold',image:'./static/gold coloured coin.jpg',name:['GOLD-COLOURED','COINS'],icon:'🪙',type:'COMMODITY',income:2,cost:5,x:1330,y:620,rot:-2,sub:'shiny. suspiciously shiny.',sp:'−2 Cortisol at the start of each of your turns; +$5 whenever GOLD RUSH is drawn.'},
{id:'train',image:'./static/coal train.png',name:['THE COAL TRAIN'],icon:'🚃',type:'COMMODITY',income:2,cost:5,x:770,y:700,rot:-2,sub:'tonnage by rail',sp:'+1 movement step each turn while owned (the express). Does not stack with THE BULLET TRAIN.'},
{id:'port',image:'./static/coal terminal.png',name:['COAL TERMINAL','THE DOCKS'],icon:'⚓',type:'COMMODITY',income:3,cost:7,x:950,y:800,rot:2,sub:'ships in the night',sp:'+$5 on CEO PHOTO LEAKS if you also own COAL CORP HQ (shipped before the news).'},
{id:'bhp',image:'./static/bhp.png',name:['BHP','THE BIG AUSTRALIAN'],icon:'⛏️',type:'COMMODITY',shape:'logo',band:'#ee3a23',income:3,cost:7,x:560,y:820,rot:-2,sub:'pit to port · ore and more',sp:'+$3 on COAL RUSH or GOLD RUSH. +$1 income while you own THE COAL TRAIN.'},
{id:'forklift',image:'./static/forklift.png',name:['THE FORKLIFT'],icon:'🚜',type:'COMMODITY',income:1,cost:4,x:1520,y:650,rot:-1,sub:'it moves everything',sp:'+$1 income per COMMODITY node you own.'},
/* — the corporates — */
{id:'coal',image:'./static/coal corp hq.png',name:['COAL CORP HQ','CEO COAL'],icon:'🚂',type:'CORPORATE',shape:'logo',band:'#3f3f3f',income:3,cost:7,x:150,y:480,rot:-2,sub:'Mark Watson, Chief Executive',sp:'+1 movement step per turn. With THE COAL TRAIN too: 4 steps — the private express.'},
{id:'quik',image:'./static/quikstop.png',name:['QUIKSTOP'],icon:'⛽',type:'CORPORATE',shape:'logo',band:'#c05621',income:2,cost:5,x:350,y:430,rot:2,sub:'the storefront · fuel, snacks & shopping bags',sp:'Collects $1 from every rival on OIL SPIKES; +$4 on PROFIT WARNING.'},
{id:'market',image:'./static/marketplace.webp',name:['MARKETPLACE','LEICHARDT'],icon:'🛍️',type:'CORPORATE',shape:'logo',band:'#b0342e',income:2,cost:5,x:170,y:660,rot:1,sub:'shopping centre · interior & exterior',sp:'+$2 income while you also own QUIKSTOP (the anchor tenant).'},
{id:'f1',image:'./static/f1.png',name:['FORMULA 1','RACING CAR'],icon:'🏎️',type:'CORPORATE',shape:'photo',income:2,cost:6,x:380,y:760,rot:-3,sub:'sponsorship pays',sp:'Unlocks THE SLIPSTREAM ($2, during movement, once per turn): +2 steps and your next seizure this turn costs $2 less.'},
{id:'qantas',image:'./static/qantas.png',name:['QANTAS','THE FLYING KANGAROO'],icon:'✈️',type:'CORPORATE',shape:'logo',band:'#e0001b',income:2,cost:20,x:575,y:975,rot:2,sub:'the spirit of australia',sp:'Cannot be reached on turn 1. Unlocks FLY THE JET ($3, during movement): teleport to any node. Hostile takeovers stay at list price forever.'},
{id:'bullet',image:'./static/bullet train.png',name:['THE BULLET TRAIN'],icon:'🚄',type:'CORPORATE',income:2,cost:6,x:95,y:1240,rot:-1,sub:'fast enough to outrun a hearing',sp:'+1 movement step each turn. Does not stack with THE COAL TRAIN — pick the faster service.'},
/* — the media — */
{id:'press',image:'./static/jtportal quite frankly.png',name:['“QUITE FRANKLY,','JTPORTAL…” PRESS ROOM'],icon:'🗣️',type:'MEDIA',shape:'bubble',income:2,cost:6,x:760,y:900,rot:-1,sub:'narrative for sale',sp:'Unlocks SPIN ($3): −2 own Cortisol or +1 rival Cortisol.'},
{id:'fox',image:'./static/fox business.png',name:['FOX BUSINESS'],icon:'🦊',type:'MEDIA',shape:'logo',band:'#1a2f6b',income:2,cost:10,x:980,y:1000,rot:2,sub:'fair & furious',sp:'Unlocks FOX SPIN ($2): −3 own Cortisol or +1 rival’s. Deflects the CEO photo leak.'},
{id:'leak',image:'./static/bondmageddon 2.png',name:['“BOND MARKETS','REVOLT” — THE LEAK'],icon:'📰',type:'MEDIA',shape:'bubble',income:2,cost:6,x:1200,y:930,rot:2,sub:'someone talked',sp:'+1 Intel when you seize it; +$2 whenever BONDMAGEDDON runs.'},
{id:'jim',image:'./static/jim chalmers breaking news.jpg',name:['“THE JIM…”','TREASURY EXCLUSIVE'],icon:'🗞️',type:'MEDIA',shape:'news',income:1,cost:4,x:1420,y:880,rot:-2,sub:'bond-market news graphic',sp:'+$2 whenever a GOVERNMENT event runs (budgets & rate decisions).'},
{id:'herald',image:'./static/the jim reaper.png',name:['HERALD SUN','THE JIM REAPER'],icon:'📰',type:'MEDIA',shape:'news',income:1,cost:4,x:1725,y:265,rot:2,sub:'front page, every page',sp:'+$2 whenever a GOVERNMENT event runs. +1 Intel whenever any rival gains Cortisol from an event.'},
{id:'bess',image:'./static/big bessent breaking news.jpg',name:['“BIG BESSENT”','BREAKING'],icon:'📣',type:'MEDIA',shape:'bubble',income:1,cost:4,x:1630,y:930,rot:-1,sub:'the big man speaks',sp:'+$2 whenever BOND or RATE events run — he moves markets by talking.'},
{id:'insider',image:'./static/insider trading graphic.png',name:['“INSIDER TRADING”','THE GRAPHIC'],icon:'⚠️',type:'MEDIA',shape:'news',income:1,cost:4,x:1830,y:860,rot:2,sub:'circled in red marker',sp:'Your BUG actions cost 0 Intel (it’s only insider trading if you’re on the outside).'},
{id:'photo',image:'./static/the big con.png',name:['THE BIG CON'],icon:'📷',type:'MEDIA',income:1,cost:5,x:1220,y:1210,rot:-2,sub:'faces pinned to cork',sp:'+1 Intel whenever any rival seizes a node — the wall sees everything.'},
{id:'bigshort',image:'./static/the big short.png',name:['THE BIG SHORT','THE CINEMA'],icon:'🎬',type:'MEDIA',shape:'logo',band:'#8a1f11',income:1,cost:4,x:1420,y:1080,rot:1,sub:'they explained it with a Jenga tower',sp:'+$3 whenever a crash event runs (BONDMAGEDDON, CRACKDOWN).'},
{id:'news',image:'./static/all the newspapers.jpg',name:['THE NEWSPAPERS','ALL OF THEM'],icon:'🗞️',type:'MEDIA',shape:'news',income:1,cost:3,x:860,y:1250,rot:-1,sub:'interest-rate clippings & small headlines',sp:'+1 Intel at the start of your turn while you own 2+ MEDIA nodes.'},
{id:'wef',image:'./static/world economic forum.webp',name:['WORLD ECONOMIC','FORUM'],icon:'🏔️',type:'MEDIA',shape:'logo',band:'#0b3d91',income:2,cost:6,x:1750,y:1300,rot:-2,sub:'the conference stage',sp:'Your bugs skim $2 instead of $1 (global networks, ski trips).'},
/* — the backrooms — */
{id:'back',image:'./static/backroom deals.png',name:['BACKROOM DEALS'],icon:'🤝',type:'WILD',income:1,cost:4,x:960,y:430,rot:-3,sub:'cash · intel · favors',sp:'Pay up to $3 of any seizure shortfall with Intel (1 🛈 = $1). Unlocks LEAN ON THE TABLE: every other player gains +1 Cortisol. Using a Backroom Deals ability during movement costs 2 movement steps.'},
{id:'term',image:'./static/bloomberg terminal.png',name:['THE TERMINAL'],icon:'📈',type:'WILD',income:1,cost:4,x:1440,y:255,rot:1,sub:'the screens never sleep',sp:'End movement here to PEEK at the top Event card — keep it or bury it.'},
{id:'golf',image:'./static/golf club.jpg',name:['THE GOLF CLUB'],icon:'⛳',type:'WILD',income:2,cost:6,x:170,y:960,rot:3,sub:'deals on the back nine',sp:'All your seizure costs are $1 cheaper.'},
{id:'whistle',image:'./static/whistleblower.png',name:['THE WHISTLEBLOWER','KNOWS TOO MUCH'],icon:'🕵️',type:'WILD',shape:'photo',income:0,cost:6,x:1980,y:640,rot:-2,sub:'half a confession ready',sp:'+1 Intel at the start of each of your turns.'},
{id:'iface',image:'./static/bloomberg terminal.png',name:['THE MARKET','INTERFACE'],icon:'🖥️',type:'WILD',income:1,cost:4,x:2060,y:1100,rot:2,sub:'computer & website screenshots',sp:'Your TERMINAL peek works wherever you end movement — everything is online.'},
/* — school & fate — */
{id:'school',image:'./static/st andrews cathedral school.png',name:['ST ANDREW’S','CATHEDRAL SCHOOL'],icon:'🏫',type:'WILD',shape:'logo',band:'#1b2a5e',income:1,cost:5,x:170,y:1080,rot:-1,sub:'the crest & the tower',sp:'+1 Intel at the start of your turn if you own 3+ CHART nodes (the research department).'},
{id:'ib',image:'./static/ibdp.png',name:['THE IB DIPLOMA','PROGRAMME'],icon:'📚',type:'WILD',income:1,cost:5,x:380,y:1050,rot:2,sub:'HL Economics, allegedly',sp:'Your CHART nodes pay DOUBLE income (Higher Level Economics).'},
{id:'mpc',image:'./static/monetary policy competition.png',name:['THE AUSTRALIAN','MONETARY POLICY','COMPETITION'],icon:'🏆',type:'WILD',shape:'mpc',income:1,cost:6,x:390,y:1200,rot:-2,sub:'the trophy of trophies',sp:'+$1 income per CHART node; +1 Intel each turn. +$2 more each turn while you also hold the SCHOOL and the IB DIPLOMA.'},
{id:'sisy',image:'./static/sisyphus.webp',name:['THE SISYPHUS','BOULDER'],icon:'🪨',type:'WILD',income:0,cost:4,x:600,y:1150,rot:2,sub:'it always rolls back down',sp:'Stand here (once owned) to PUSH: earn $10 the first time, then double the payout every push ($10, $20, $40, $80…). No Cortisol cost.'},
{id:'group',image:'./static/the outdoors.png',name:['THE OUTDOOR','GROUP PHOTOGRAPH'],icon:'👥',type:'WILD',shape:'wide',income:1,cost:4,x:820,y:1120,rot:-1,sub:'everyone smiled',sp:'Whenever ANY player is raided, gain +1 Intel (you have photos of everyone).'},
{id:'sat',image:'./static/the outback.jpg',name:['SATELLITE IMAGE','THE OUTBACK'],icon:'🛰️',type:'WILD',shape:'sat',income:1,cost:4,x:610,y:1300,rot:1,sub:'landscape · the dry country',sp:'−1 Cortisol at the start of each of your turns (hiding out bush).'},
/* — the people (polaroids) — */
{id:'watson',image:'./static/ceo of coal.png',name:['MARK WATSON','CEO OF COAL'],icon:'🕴️',type:'WILD',shape:'photo',income:0,cost:6,x:330,y:590,rot:3,sub:'the face of the company',sp:'+$2/turn while you also own COAL CORP HQ. Exempts your COAL industry holdings from ACCC monopoly investigations. Personally deflects the CEO PHOTO LEAK.'},
{id:'bessent',image:'./static/scott bessent.png',name:['SCOTT BESSENT','“BIG BESSENT”'],icon:'👔',type:'WILD',shape:'photo',income:1,cost:7,x:1600,y:310,rot:-2,sub:'US Treasury · moves markets',sp:'+$1 income per BANK node you own.'},
{id:'chalmers',image:'./static/jim chalmers.png',name:['JIM CHALMERS','“THE JIM”'],icon:'👨‍💼',type:'WILD',shape:'photo',income:1,cost:8,x:1720,y:180,rot:2,sub:'the Treasurer',sp:'+$1 income per REGULATOR node you own (the Treasurer’s friends).'},
{id:'albo',image:'./static/albo.png',name:['ANTHONY ALBANESE','THE PM'],icon:'🫡',type:'WILD',shape:'photo',income:1,cost:8,x:1875,y:105,rot:-2,sub:'the motorcade',sp:'Tolls rivals pay to enter YOUR nodes are $2 (the PM closes the road). Unlocks BLOCKADE (free, once per turn): wall off literally any node for one full rotation — nobody walks or flies in, not even you.'},
{id:'trump',image:'./static/trump.png',name:['DONALD TRUMP','TARIFF MAN'],icon:'🦅',type:'WILD',shape:'photo',income:1,cost:7,x:2020,y:185,rot:2,sub:'the tweets move markets',sp:'Unlocks THE TWEET ($2): choose a rival to lose the greater of 3 Intel or 50% of their Intel.'},
{id:'bullock',image:'./static/michelle bullock.png',name:['MICHELE BULLOCK','RBA GOVERNOR'],icon:'👩‍💼',type:'WILD',shape:'photo',income:1,cost:7,x:880,y:265,rot:-3,sub:'she decides the cash rate',sp:'Rate events never charge you; +1 Intel each turn (the Governor briefs you).'},
{id:'bond007',image:'./static/james bond.png',name:['JAMES BOND','CITIBANK · 007'],icon:'🤵',type:'WILD',shape:'photo',income:1,cost:6,x:300,y:330,rot:-2,sub:'banker. sort of.',sp:'You pay NO tolls (he has… credentials).'},
{id:'rock',image:'./static/the rock.gif',name:['THE ROCK','CAN SMELL IT'],icon:'💪',type:'WILD',shape:'photo',income:1,cost:7,x:660,y:450,rot:2,sub:'final boss energy',sp:'Unlocks COOK THE BOOKS ($3): −3 Cortisol. +$1 income per DIFFERENT node type you own.'},
{id:'brad',image:'./static/brad pitt.png',name:['BRAD PITT','“THE BIG SHORT”'],icon:'😎',type:'WILD',shape:'photo',income:1,cost:5,x:1630,y:1120,rot:-2,sub:'explained it in the movie',sp:'+$2 whenever a BOND event runs (he had it explained to him).'},
{id:'jt',image:'./static/jt portal.png',name:['JTPORTAL','QUITE FRANKLY'],icon:'🌐',type:'WILD',shape:'photo',income:1,cost:9,x:1150,y:540,rot:-1,sub:'the legend of the board',sp:'+1 Intel each turn AND you are shown the next Market Event at the start of your turn. ONCE PER GAME: cancel a Market Event as it is revealed — “quite frankly, it never happened.”'},
{id:'made',image:'./static/made logo.png',name:['MADE','(???)'],type:'WILD',shape:'made',income:2,cost:7,x:1000,y:1380,rot:-2,sub:'the purple graphic',sp:'Start of every turn: a chance MADE pays out (33% at 2 seats, falling to 8% at 8) — +$10 and +1 Intel to its owner. Every other player with more than two nodes and at least $50 pays 15% of their cash. No Cortisol is added. Hostile takeovers of MADE stay at list price forever. Nobody knows why. NOBODY.'},
{id:'asics',image:'./static/running shoe.jpg',name:['THE RUNNING SHOE','ASICS'],icon:'👟',type:'WILD',shape:'photo',income:1,cost:3,x:430,y:1360,rot:3,sub:'circled in red · why is this here',sp:'+1 movement step (you are always jogging). Stand here (once owned) to JOG: free −1 Cortisol.'},
{id:'toktimer',image:'./static/toktimer.png',name:['TOKTIMER'],icon:'⏱️',type:'WILD',shape:'photo',income:1,cost:5,x:1920,y:1020,rot:-2,sub:'the clock is running',sp:'+1 Intel whenever a Market Event is revealed. Time is information.'}
];
/* ─────────── 🌍 GEOGRAPHY DLC — twelve more pins, host-toggled in the lobby ───────────
   The whole GEOGRAPHY set is appended to BASE_NODES only when the lobby flag is on
   (rebuildWorld). Abilities are id-hooked exactly like the base game: startTurn
   passives, income() synergies, and applyIntent actions keyed on the node id. */
let NODES=[];
const GEO_NODE_IDS=['geo_missile','geo_shahed','geo_wonsan','geo_pyoncity','geo_pyothotel','geo_boeing','geo_scs','geo_stage5','geo_pillars','geo_venice','geo_tuvalu','geo_kim'];
const OIL_IDS=['oil','oilgraph','barrels','tanker','petronas'];
const GEO_HIGH_VALUE_IDS=['geo_missile','geo_shahed','geo_scs','geo_pyothotel','geo_boeing','geo_pillars','geo_kim','geo_wonsan','geo_venice','geo_pyoncity','geo_stage5'];
/* Related North Korea DLC pins; their physical positions are deliberately not clustered. */
const GEO_NK_IDS=['geo_missile','geo_wonsan','geo_pyoncity','geo_pyothotel','geo_kim'];
const GEO_NODES=[
{id:'geo_missile',image:'./static/GeographyDLC/nk_missile.jpg',name:['MISSILE COMMAND'],icon:'🚀',type:'REGULATOR',shape:'photo',income:0,cost:8,x:2140,y:1180,rot:2,sub:'strategic assets · keys under the desk',sp:'Unlocks LAUNCH A MISSILE ($4 + 1 Intel, once per turn): strike any node — but you must BE HERE to fire, during your move (the launch ends the move; your action still follows) or as your action (owning KIM JONG UN also arms the silo from anywhere). An owned node is expropriated with NO payout; either way it becomes rubble — no income, no seizing. Stand on rubble in your action phase and pay the list price to rebuild it; it returns unowned, buyable from next turn. ESG is vulnerable to missile strikes.'},
{id:'geo_shahed',image:'./static/GeographyDLC/shahed drone.webp',name:['IRANIAN','SHAHED DRONE'],icon:'🛩️',type:'REGULATOR',shape:'photo',income:0,cost:8,x:420,y:1120,rot:-2,sub:'one-way delivery · disposable diplomacy',sp:'Functions like MISSILE COMMAND: launch a missile for $4 + 1 Intel, once per turn. Fire while standing on the drone you own, or from anywhere if you own KIM JONG UN. You cannot own this and MISSILE COMMAND at the same time.'},
{id:'geo_wonsan',image:'./static/GeographyDLC/nk_wonsanresort.jpg',name:['WONSAN','RESORT'],icon:'🏖️',type:'WILD',shape:'photo',income:2,cost:5,x:2080,y:700,rot:-2,sub:'the beach town · sanctioned paradise',sp:'Stand here (once owned) for BEACH DAY: free, once per turn, −2 Cortisol. The sand is quiet. The waves are loud. Nobody is watching.'},
{id:'geo_pyoncity',image:'./static/GeographyDLC/nk_pyongyangcity.webp',name:['PYONGYANG','CITY'],icon:'🌆',type:'BANK',shape:'photo',income:2,cost:6,x:2240,y:1000,rot:1,sub:'the capital · show windows, all lit',sp:'+$1 income per GEOGRAPHY DLC node you own (the capital collects tribute).'},
{id:'geo_pyothotel',image:'./static/GeographyDLC/nk_pyongyanghotel.jpg',name:['PYONGYANG','HOTEL'],icon:'🏨',type:'CORPORATE',shape:'photo',income:2,cost:8,x:2200,y:830,rot:-1,sub:'106 floors · 47 in use',sp:'Gain $2 whenever ANY rubble node is REBUILT (construction kickbacks, allegedly).'},
{id:'geo_boeing',image:'./static/GeographyDLC/geo_boeing.jpg',name:['THE CORPORATE','BOEING'],icon:'🛩️',type:'CORPORATE',shape:'photo',income:2,cost:7,x:1920,y:590,rot:2,sub:'white tail · no livery · no paperwork',sp:'Unlocks SHUT DOWN QANTAS ($4, once per turn): the kangaroo is grounded for two full turns — nobody flies the jet, and its owner collects nothing from it.'},
{id:'geo_scs',image:'./static/GeographyDLC/geo_southchinasea.jpg',name:['THE SOUTH','CHINA SEA'],icon:'🌊',type:'COMMODITY',shape:'photo',income:4,cost:9,x:1880,y:1300,rot:-2,sub:'disputed waters · freedom of navigation',sp:'Unlocks TRIGGER AN OIL CRASH ($3, once per turn): the mood turns PANIC and every player pays $2 per oil node they own. Pillars-protected players are exempt.'},
{id:'geo_stage5',image:'./static/GeographyDLC/geo_stage5decline.png',name:['STAGE 5','DECLINE'],type:'CHART',shape:'chart',spark:'down',income:1,cost:4,x:2040,y:470,rot:1,sub:'imported uranium · charcoal · decay',sp:'Unlocks CALL STAGE 5 (2 Intel, once per turn): the current richest player (not you) makes NO income on their next turn.'},
{id:'geo_pillars',image:'./static/GeographyDLC/geo_pillars.jpg',name:['PILLARS OF','SUSTAINABILITY'],icon:'🧱',type:'REGULATOR',shape:'photo',income:1,cost:6,x:1760,y:250,rot:-1,sub:'ESG-laminated · one pillar is cardboard',sp:'ESG SHIELD: −1 Cortisol at the start of each of your turns. You still pay nothing on an OIL CRASH and Stage 5 Decline cannot call you, but the Pillars themselves can be missile-struck and your holdings remain vulnerable to Overtourism.'},
{id:'geo_venice',image:'./static/GeographyDLC/geo_venice.jpg',name:['VENICE','DI CCTV'],type:'MEDIA',shape:'photo',income:3,cost:8,x:150,y:950,rot:2,sub:'la serenissima · sella aperta',sp:'Stand here (once owned) for GONDOLA THERAPY: free, once per turn, −1 Cortisol. Or in your action phase send OVERTOURISM ($2, once per turn, either/or): pick a rival node — its owner takes +1 Cortisol at the start of each of their turns while the cruise ships keep coming.'},
{id:'geo_tuvalu',image:'./static/GeographyDLC/geo_tuvalu.png',name:['TUVALU','.TV'],icon:'🏝️',type:'WILD',shape:'photo',income:2,cost:5,x:1900,y:1420,rot:-2,sub:'the first country you get free',sp:'THE JOIN IS FREE: the first player to arrive simply owns it. No action, no cost, no Cortisol. After that, normal rules apply.'},
{id:'geo_kim',image:'./static/GeographyDLC/nk_kimjongun.png',name:['KIM JONG','UN'],icon:'🧨',type:'WILD',shape:'photo',income:0,cost:6,x:2320,y:1210,rot:-2,sub:'the man himself · nothing is happening',sp:'+1 Intel at the start of each of your turns. Owning him exempts you from either launcher’s on-site rule — both the silo and the Shahed can fire from anywhere.'},
];
const GEO_EDGES=[
 ['geo_missile','geo_pyoncity'],['geo_pyoncity','geo_pyothotel'],['geo_pyothotel','geo_wonsan'],['geo_wonsan','geo_missile'],
 ['geo_boeing','geo_pyothotel'],['geo_missile','geo_stage5'],['geo_stage5','geo_pillars'],
 ['geo_scs','geo_tuvalu'],['geo_venice','geo_scs'],
 ['geo_kim','geo_missile'],['geo_kim','geo_pyoncity'],['geo_shahed','geo_venice']
];
const NMAP={};
/* The Geography DLC rebuilds these every time the lobby flag flips. */
let ORIGINAL_NODE_LAYOUT=[];
let ORIGINAL_LAYOUT_BY_ID={};

const COUNTRY=['us','japan','uk','aus'];
const BASE_EDGES=[
 /* banks & the missing fourth */
 ['citi','commbank'],['commbank','nab'],['nab','anz'],['nab','westpac'],['westpac','commbank'],['westpac','citi'],['anz','rba'],['citi','bond007'],['citi','coal'],
 /* regulators row */
 ['rba','bullock'],['rba','asic'],['asic','accc'],['accc','gov'],['gov','chalmers'],['chalmers','albo'],['albo','trump'],['rba','bond'],['gov','herald'],
 /* desks & screens */
 ['bond','hedge'],['bond','bessent'],['bond','back'],['hedge','term'],['hedge','stock'],['term','bessent'],['term','stock'],
 /* charts — each lives in a different neighbourhood, linked to neighbours AND the master */
 ['rba','cash'],['cash','bullock'],['cash','tenyear'],['aus','gov'],['aus','accc'],['aus','tenyear'],['gov','chalmers'],['chalmers','tenyear'],
 ['us','trump'],['us','albo'],['us','tenyear'],['japan','petronas'],['japan','tanker'],['japan','tenyear'],
 ['uk','press'],['uk','news'],['uk','tenyear'],['tenyear','bessent'],['tenyear','bond'],
 ['infl','jt'],['infl','back'],
 ['stock','oilgraph'],
 
 /* commodities */
 ['oil','oilgraph'],['oil','tanker'],['oil','petronas'],['oil','barrels'],['oil','jt'],['barrels','forklift'],['forklift','port'],['forklift','gold'],
 ['tanker','port'],['tanker','petronas'],['petronas','trump'],
 ['train','coal'],['train','watson'],['train','port'],['train','rock'],['train','bhp'],['bhp','coal'],['bhp','watson'],['bhp','market'],
 /* corporates & the wandering servo */
 ['coal','watson'],['coal','quik'],['quik','market'],['quik','bond007'],['quik','watson'],['market','f1'],
 ['f1','qantas'],['qantas','press'],['qantas','golf'],['bullet','school'],['bullet','albo'],['bullet','golf'],['bullet','asics'],
 /* media ring */
 ['back','press'],['back','leak'],['back','jt'],['iface','toktimer'],
 ['press','leak'],['press','fox'],['press','golf'],['press','news'],['leak','photo'],['photo','news'],['photo','bigshort'],['photo','made'],
 ['news','fox'],['news','made'],['fox','jim'],['jim','bess'],['jim','herald'],['bess','insider'],['bess','wef'],['bess','herald'],
 ['insider','whistle'],['wef','brad'],['wef','iface'],['bigshort','brad'],['hedge','bigshort'],
 /* school, fate, shoes, the clock */
 ['school','ib'],['school','mpc'],['school','golf'],['ib','mpc'],['mpc','sisy'],['sisy','group'],['sisy','sat'],
 ['group','sat'],['group','press'],['group','news'],['sat','made'],['sat','asics'],['asics','mpc'],['asics','sisy'],
 ['toktimer','whistle'],['toktimer','brad'],
 /* people bridges */
 ['bullock','rock'],['rock','jt'],['jt','press'],['watson','golf'],['chalmers','herald']
];
const REMOVED_NODE_IDS=new Set(['notes','vault','unid1','unid2','real','spend','can','tv','ger','timeline','econ','debt']);
let CLEAN_EDGES=[],WORLD_EDGES=[],EDGES=[],HIGH_VALUE_NODE_IDS=new Set();
const ADJ={};
function rebuildAdj(){
 Object.keys(ADJ).forEach(k=>delete ADJ[k]);
 EDGES.forEach(e=>{
  if(!NMAP[e[0]]||!NMAP[e[1]])return;
  (ADJ[e[0]]=ADJ[e[0]]||[]).push(e[1]);
  (ADJ[e[1]]=ADJ[e[1]]||[]).push(e[0]);
 });
}
rebuildAdj();
/* ================= 🌍 WORLD REBUILD — the DLC toggle rewires everything =================
   The lobby's Geography flag changes the node set, so every derived mapping is
   recomputed from scratch: NMAP, the canonical layout deck, the edge graph and
   the high-value seeding set. With the flag off this produces a world that is
   byte-for-byte the game as it has always been. */
const HIGH_VALUE_BASE_IDS=[
 'qantas','rba','oil','gold','sat','asics','rock','press','fox','sisy',
 'made','bullock','jt','mpc','whistle','term','bond','hedge','petronas'
];
let WORLD_GEO=false;
function rebuildWorld(geo){
 WORLD_GEO=!!geo;
 NODES=geo?BASE_NODES.concat(GEO_NODES):BASE_NODES.slice();
 Object.keys(NMAP).forEach(k=>delete NMAP[k]);
 NODES.forEach(n=>NMAP[n.id]=n);
 ORIGINAL_NODE_LAYOUT=NODES.map(n=>({id:n.id,x:n.x,y:n.y,rot:n.rot}));
 ORIGINAL_LAYOUT_BY_ID=Object.fromEntries(ORIGINAL_NODE_LAYOUT.map(p=>[p.id,p]));
 CLEAN_EDGES=BASE_EDGES.filter(e=>!REMOVED_NODE_IDS.has(e[0])&&!REMOVED_NODE_IDS.has(e[1]));
 WORLD_EDGES=geo?CLEAN_EDGES.concat(GEO_EDGES):CLEAN_EDGES.slice();
 EDGES=WORLD_EDGES.map(e=>e.slice());
 HIGH_VALUE_NODE_IDS=new Set(HIGH_VALUE_BASE_IDS.concat(geo?GEO_HIGH_VALUE_IDS:[]));
 rebuildAdj();
}
rebuildWorld(false);
/* Quikstop is the only exhibit that physically moves each game — five neighbourhoods, same servo */
const QUIK_HOME={x:350,y:430,rot:2};
const QUIK_SLOTS=[
 {x:350,y:430,rot:2,links:['coal','watson','bond007','market','train'],label:'the original servo · inner west'},
 {x:1540,y:1210,rot:-2,links:['photo','bigshort','market','news'],label:'down by MarketPlace · the late shift'},
 {x:2060,y:680,rot:1,links:['forklift','petronas','whistle'],label:'the docks servo · petrol & crude'},
 {x:700,y:280,rot:-1,links:['rba','bullock','rock','westpac','cash'],label:'across from the Reserve Bank'},
 {x:1120,y:1410,rot:2,links:['made','sat','news','photo'],label:'the unexplained servo · next to MADE'}
];
const TYPE_COLORS={BANK:'#a87511',COMMODITY:'#c05621',MEDIA:'#b5308c',CORPORATE:'#1f6f8b',REGULATOR:'#5c6b73',CHART:'#2e8b57',WILD:'#6b4fa0'};
const PCOLORS=['#f5c542','#55c1ff','#e19bff','#7fe08d','#ff5e9c','#ffffff','#00e5c0','#ffa94d'];
const MAXPLAYERS=8;
const CHARURL='/characters/';
const CHARS=[
 {id:'markwatson',name:'Mark Watson',file:'markwatson.png',color:'#f5c542'},
 {id:'tomkins',name:'Tomkins',file:'tomkins.png',color:'#55c1ff'},
 {id:'jimchalmers',name:'Jim Chalmers',file:'jimchalmers.png',color:'#e19bff'},
 {id:'bessock',name:'Bessock',file:'bessock.png',color:'#7fe08d'},
 {id:'calvinathanasius',name:'Calvin Athanasius',file:'calvinathanasius.png',color:'#ff5e9c'},
 {id:'denialswan',name:'Denial Swan',file:'denialswan.png',color:'#ffffff'},
 {id:'japsnchen',name:'Japsn Chen',file:'japsnchen.png',color:'#00e5c0'},
 {id:'thousandyardwax',name:'Thousand Yard Wax',file:'thousandyardwax.png',color:'#ffa94d'},
 {id:'Alexander_Lane',name:'The guy from Toktimer',file:'Alexander_Lane.png',color:'#ff6b5e'},
 {id:'DJT',name:'QUITE FRANKLY',file:'DJT.png',color:'#9b8cff'},
 {id:'thebigag',name:'The Big Ag',file:'thebigag.png',color:'#d6e85c'},
 {id:'thebigwegrzyn',name:'Seth Wegrzyn',file:'thebigwegrzyn.png',color:'#e8a07a'}
];
function charMeta(id){return CHARS.find(c=>c.id===id)||null}
function charSrc(id){const c=charMeta(id);return c?(c.url||CHARURL+c.file):''}
/* ================= THE MARKET MOOD — set by every event, felt by everyone ================= */
const MOODS={
 CALM:{label:'MARKET: CALM',color:'#8fbf7f',tint:'rgba(70,130,70,0.045)',rate:2,desc:'no modifiers · 1 🛈 = $2'},
 BOOM:{label:'MARKET: BOOM',color:'#f5c542',tint:'rgba(200,160,40,0.075)',rate:2,desc:'COMMODITIES +$1/turn · 1 🛈 = $2'},
 PANIC:{label:'MARKET: PANIC',color:'#ff6b5e',tint:'rgba(170,30,20,0.10)',rate:4,desc:'BANKS −$1/turn · 1 🛈 = $4'},
 FRENZY:{label:'MEDIA FRENZY',color:'#e19bff',tint:'rgba(150,60,170,0.075)',rate:3,desc:'MEDIA +$1/turn · 1 🛈 = $3'}
};
/* sparklines drawn INSIDE the 130x64 chart card (card spans x -65..65, y -32..32;
   line band: x -50..50, y 0..14) */
const SPK={
up:'-50,13 -34,11 -18,12 -2,7 14,9 30,3 42,5 50,1',
down:'-50,2 -34,4 -18,3 -2,8 14,7 30,11 42,10 50,13',
step:'-50,13 -30,13 -30,9 -8,9 -8,5 16,5 16,2 50,2',
spike:'-50,13.5 -34,13 -18,11.5 -2,12 14,7 30,3 42,0.5 50,0',
vola:'-50,7 -38,12 -26,3 -14,10 -2,5 10,12 22,2 34,9 46,1 50,5',
flat:'-50,9 -25,8.5 0,9 25,8.5 50,8'};

/* ================= MARKET EVENT DECK (24 cards) — every card moves the mood ================= */
const CARDS=[
{id:'oilspike',icon:'🛢️',title:'OIL SPIKES — WTI +12%',text:'Crude goes vertical. The pit pays out, the tankers get rich, and everyone pays at the pump.',
 run(){setMood('BOOM','WTI +12% — crude goes vertical');[['oil',6,'crude windfall'],['oilgraph',2,'the graph called it'],['tanker',3,'tankers rechartered at panic rates'],['petronas',3,'the national oil company'],['barrels',2,'the barrel yard']].forEach(a=>{const o=S.owner[a[0]];if(o!=null)gain(o,a[1],a[2])});const q=S.owner.quik;S.players.forEach((pl,i)=>{if(i===q)return;if(q==null)payVoid(i,1,'fuel costs — nobody minds the till');else payTo(i,1,q,'fuel costs → QuikStop')});}},
{id:'coalrush',icon:'🚃',title:'COAL RUSH',text:'Demand for black rock goes nuclear. Everything on rails and water makes money.',
 run(){setMood('BOOM','coal rush — everything on rails makes money');[['port',4,'the docks work overtime'],['train',2,'the train runs all night'],['tanker',3,'freight rates through the roof'],['coal',2,'COAL Corp books all of it'],['forklift',1,'pallets upon pallets'],['bhp',3,'the Big Australian books the tonnes']].forEach(a=>{const o=S.owner[a[0]];if(o!=null)gain(o,a[1],a[2])});}},
{id:'rates',icon:'🏛️',title:'RBA CASH-RATE DECISION',text:'Governor Bullock leans into the microphone. Money gets expensive — for everyone but the insiders.',
 run(){setMood('CALM','the RBA decides — the market holds its breath, then exhales');const r=S.owner.rba,b=S.owner.bullock;S.players.forEach((pl,i)=>{if(i===r||i===b)return;payFee(i,2,'the cost of money')});if(r!=null)log('🏛️ '+pname(r)+' set the rate — pays nothing.');if(b!=null)log('👩‍💼 The Governor takes '+pname(b)+'’s calls — pays nothing.');const c=S.owner.cash;if(c!=null)gain(c,2,'you literally set it');const j=S.owner.jim;if(j!=null)gain(j,2,'the headline sells papers');const be=S.owner.bess;if(be!=null)gain(be,2,'“BIG BESSENT” reacts live');const hs=S.owner.herald;if(hs!=null)gain(hs,2,'THE JIM REAPER reprints the decision');}},
{id:'bondrevolt',icon:'💥',title:'BONDMAGEDDON',text:'“Government Bond: the collapse of the world’s safest investment.” Yields go vertical from Tokyo to Toronto.',
 run(){setMood('PANIC','“the collapse of the world’s safest investment”');const bd=S.owner.bond;S.players.forEach((pl,i)=>{const banks=NODES.filter(n=>n.type==='BANK'&&S.owner[n.id]===i).length;if(!banks)return;const amt=banks*2;if(bd!=null)payTo(i,amt,bd,'the revolt eats '+banks+' bank position'+(banks>1?'s':'')+' → The Bond Desk');else payVoid(i,amt,'the revolt eats the banking book')});COUNTRY.forEach(c=>{const o=S.owner[c];if(o!=null)gain(o,c==='japan'?3:1,NMAP[c].name.join(' ')+' pays its reader')});const t=S.owner.tenyear;if(t!=null)gain(t,2,'the master chart was right');const be=S.owner.bess;if(be!=null)gain(be,2,'Big Bessent called it on air');const br=S.owner.brad;if(br!=null)gain(br,2,'he had it explained in the movie');const bs=S.owner.bigshort;if(bs!=null)gain(bs,3,'the cinema saw it coming');const lk=S.owner.leak;if(lk!=null)gain(lk,2,'the leak was first with it');}},
{id:'ceophoto',icon:'📸',title:'CEO PHOTO LEAKS — COAL CORP',text:'Mark Watson, photographed exactly where he should not have been. Someone is holding matches.',
 run(){setMood('FRENZY','CEO photo leaks — the front pages feed');const c=S.owner.coal;if(c==null){log('🚂 COAL CORP HQ is unowned — Watson denies everything to an empty room.');return}if(S.owner.watson===c){log('🕴️ Watson fronts the cameras himself — the photos are dismissed as “old”. No Cortisol.');return}if(S.owner.port===c)gain(c,5,'shipped the coal before the news broke');if(S.owner.press===c||S.owner.fox===c){gain(c,3,'the press room spins it beautifully');return}addCortisol(c,3,'the photos run on every front page','event');}},
{id:'tariffs',icon:'🦅',title:'TRUMP TWEETS TARIFFS',text:'ALL CAPS. Exclamation points. Global markets do a synchronized swan dive.',
 async run(){setMood('PANIC','TARIFFS! ALL CAPS! markets swan-dive');const t=S.owner.trump;let chain;const opts=[{label:'🛢️ OIL chain +$3 each',v:'oil'},{label:'🚂 COAL chain +$3 each',v:'coal'}];
 if(t!=null)chain=await askPlayer(t,{title:'TRUMP TWEETS TARIFFS',body:'You own THE DONALD — which chain gets the windfall?',options:opts,def:Math.random()<.5?'oil':'coal'});
 else chain=Math.random()<.5?'oil':'coal';
 const list=chain==='oil'?['oil','oilgraph','barrels','tanker','petronas']:['coal','train','port','watson','forklift','bhp'];
 const winners=new Set();list.forEach(id=>{const o=S.owner[id];if(o!=null){gain(o,3,chain+' windfall via '+NMAP[id].name[0]);winners.add(o)}});
 const u=S.owner.us;if(u!=null){gain(u,2,'the safe-haven bid');winners.add(u)}
 S.players.forEach((pl,i)=>{if(!winners.has(i))payVoid(i,1,'the tariff bill')});
 if(t!=null)log('🦅 The tweet did numbers.');}},
{id:'besspeak',icon:'🎤',title:'BIG BESSENT SPEAKS',text:'The Treasury clears its throat. Bond desks straighten their ties. Markets listen.',
 run(){setMood('CALM','Big Bessent soothes the desk');const b=S.owner.bessent;if(b!=null)gain(b,3,'the big man speaks');const d=S.owner.bond;if(d!=null)gain(d,2,'the desk frontran the speech');const t=S.owner.tenyear;if(t!=null)gain(t,2,'yields obey');const br=S.owner.brad;if(br!=null)gain(br,2,'he had it explained to him');}},
{id:'budget',icon:'📰',title:'THE JIM DELIVERS THE BUDGET',text:'“The Jim…” reads numbers to a sleepy chamber. Somebody, somewhere, is counting.',
 run(){setMood('CALM','the budget is delivered — mostly numbers');const s=S.owner.spend;if(s!=null)gain(s,3,'the spending graphic glows');const ch=S.owner.chalmers;if(ch!=null)gain(ch,2,'the Treasurer delivers');const j=S.owner.jim;if(j!=null)gain(j,2,'the exclusive pays');const hs=S.owner.herald;if(hs!=null)gain(hs,2,'THE JIM REAPER special edition');const a=S.owner.albo;if(a!=null)gain(a,1,'the PM signs it');S.players.forEach((pl,i)=>{if(i!==s&&i!==ch&&i!==j&&i!==a&&i!==hs)payVoid(i,1,'return to sender (taxes)')});}},
{id:'mpcfinals',icon:'🏆',title:'MONETARY POLICY COMPETITION FINALS',text:'The RBA’s big night. Schools. Charts. Trophies. JTPortal is rumoured to be judging.',
 run(){setMood('BOOM','monetary policy finals — the schools deliver');const m=S.owner.mpc;if(m!=null){gain(m,4,'the champions’ purse');giveIntel(m,1,'the finalists’ data')}const sc=S.owner.school;if(sc!=null)gain(sc,2,'the school places');const ib=S.owner.ib;if(ib!=null)gain(ib,2,'the IB cohort delivers');const jt=S.owner.jt;if(jt!=null)giveIntel(jt,1,'JTPortal judged the submissions');}},
{id:'sisyroll',icon:'🪨',title:'THE BOULDER ROLLS BACK DOWN',text:'Empires, portfolios, homework — everything heavy slides. The biggest players feel it most.',
 run(){setMood('CALM','the boulder rolls back down, as ever');const counts=S.players.map((pl,i)=>NODES.filter(n=>S.owner[n.id]===i).length);const mx=Math.max(...counts);S.players.forEach((pl,i)=>{if(counts[i]===mx&&S.owner.sisy!==i)payVoid(i,2,'the boulder finds the biggest stack')});const s=S.owner.sisy;if(s!=null)log('🪨 '+pname(s)+' is used to this — immune.');}},
{id:'goldrush',icon:'🪙',title:'GOLD RUSH',text:'The gold-coloured coins gleam. Paper money suddenly looks like a rumor.',
 run(){setMood('BOOM','gold gleams — paper looks like a rumor');const g=S.owner.gold;if(g!=null)gain(g,5,'everything gleams');const n=S.owner.notes;if(n!=null)gain(n,2,'collectors pay up');const bh=S.owner.bhp;if(bh!=null)gain(bh,3,'ore prices sneak up with the gold');S.players.forEach((pl,i)=>{if(i!==g&&i!==n&&i!==bh)payVoid(i,1,'inflation bites')});}},
{id:'rockcooks',icon:'💪',title:'THE ROCK COOKS',text:'A gym, a blender, a set of books that needed cooking. The smell is unmistakable.',
 run(){setMood('CALM','the books are cooked; the gym is calm');const r=S.owner.rock;if(r!=null){gain(r,3,'ladder of opportunity');addCortisol(r,-1,'the calm after the cook')}else log('💪 Nobody owns The Rock. The books stay raw.');}},
{id:'davos',icon:'🏔️',title:'DAVOS — THE CONFERENCE STAGE',text:'Lanyards, panels, fondue. Global networks tighten over canapés.',
 run(){setMood('FRENZY','Davos — lanyards, panels, fondue');const w=S.owner.wef;if(w!=null)gain(w,3,'the big table pays out');const b=S.owner.bessent;if(b!=null)gain(b,2,'a familiar face on the panel');Object.keys(S.bugs).forEach(nid=>{const o=S.bugs[nid];S.players[o].money+=1;log('🏔️ Global skim from '+NMAP[nid].name.join(' ')+': '+pname(o)+' +$1.')});}},
{id:'quikrob',icon:'🎭',title:'QUIKSTOP ROBBERY',text:'A ski mask, a shopping bag, an empty register. The tapes are… missing.',
 run(){setMood('CALM','a ski mask, a shopping bag, an empty register');const q=S.owner.quik;if(q==null){S.players.forEach((pl,i)=>payVoid(i,1,'nobody was watching the till'));return}payVoid(q,2,'gone, just gone');const b=S.owner.bond007;if(b!=null)gain(b,2,'he was there in disguise (allegedly)');}},
{id:'ibexams',icon:'📝',title:'IB EXAMS',text:'Papers, calculators, despair. The Diploma Programme does not grade on charisma.',
 run(){setMood('CALM','IB exams — despair, indexed');const ib=S.owner.ib;if(ib!=null)giveIntel(ib,2,'HL Economics pays off');const sc=S.owner.school;if(sc!=null)giveIntel(sc,1,'the cohort crammed');S.players.forEach((pl,i)=>{const charts=NODES.filter(n=>n.type==='CHART'&&S.owner[n.id]===i).length;if(charts===0&&pl.intel>0){pl.intel-=1;fxAt(i,'🛈−1','#55c1ff');log('📝 '+pname(i)+' didn’t do the reading: −1 Intel.')}});}},
{id:'profit',icon:'⛽',title:'PROFIT WARNING… FOR OTHERS',text:'Markets wobble, people stress-eat. Quikstop does just fine.',
 run(){setMood('CALM','profit warning… for others');const q=S.owner.quik;if(q!=null)gain(q,4,'snack economics');else log('⛽ Quikstop is unowned — the profits drift away.');}},
{id:'quiet',icon:'🌙',title:'A QUIET QUARTER',text:'No tweets, no leaks, no rate decisions. Everyone quietly pockets a little extra.',
 run(){setMood('CALM','a quiet quarter — no tweets, no leaks');S.players.forEach((pl,i)=>gain(i,2,'a quiet quarter'));}},
{id:'snoop',icon:'🔍',title:'REGULATORS SNOOP AROUND',text:'Somebody asked one question too many. The sweatiest players get a second look.',
 run(){setMood('CALM','regulators asking one question too many');const mx=Math.max(0,...S.players.map(pl=>pl.cortisol));if(mx<=0){log('🔍 Nobody has any Cortisol — the regulators go for coffee.');return}S.players.forEach((pl,i)=>{if(pl.cortisol===mx)addCortisol(i,1,'regulators circling','event')});}},
{id:'tip',icon:'✉️',title:'ANONYMOUS TIP',text:'A brown envelope with no return address. Everyone learns something.',
 run(){setMood('CALM','a brown envelope, no return address');S.players.forEach((pl,i)=>giveIntel(i,1,'the envelope'));log('✉️ Every player gains 1 Intel.');}},
{id:'frenzy',icon:'🗣️',title:'MEDIA FRENZY',text:'“Quite frankly…” The press needs a villain before deadline. Whoever owns the narrative picks one.',
 async run(){setMood('FRENZY','the press needs a villain before deadline');const pi=S.owner.press;if(pi==null){log('🗣️ The Press Room is unowned — the story dies in committee.');return}const rivals=S.players.map((pl,i)=>i).filter(i=>i!==pi);const opts=rivals.map(i=>({label:S.players[i].name+' +2 🔥',v:i}));opts.push({label:'Sit on the story',v:-1});const v=await askPlayer(pi,{title:'MEDIA FRENZY',body:'You control the PRESS ROOM — torch which rival?',options:opts,def:-1});if(v>=0)addCortisol(v,2,'front-page frenzy','event');}},
{id:'crackdown',icon:'🚨',title:'MONOPOLY ALERT',text:'The regulator finally does something. The hottest player pays for it.',
 run(){setMood('PANIC','crackdown — the regulator finally does something');const mx=Math.max(0,...S.players.map(pl=>pl.cortisol));if(mx<=0){log('🚨 Nobody is hot — the crackdown hits an empty office.');return}S.players.forEach((pl,i)=>{if(pl.cortisol===mx)payFee(i,4,'crackdown fine')});const bs=S.owner.bigshort;if(bs!=null)gain(bs,3,'the cinema called it');}},
{id:'tapes',icon:'🗑️',title:'THE TAPES GO MISSING',text:'A shredder runs all night. What you knew, you no longer know — unless you kept copies.',
 run(){setMood('CALM','the tapes go missing — a shredder runs all night');S.players.forEach((pl,i)=>{if(S.owner.whistle===i){giveIntel(i,2,'the Whistleblower kept copies')}else if(S.owner.jt===i){giveIntel(i,2,'JTPortal keeps backups')}else if(pl.intel>0){pl.intel-=1;fxAt(i,'🛈−1','#55c1ff');log('🗑️ '+pname(i)+' loses 1 Intel — the tapes are gone.')}});}},
{id:'bigscreen',icon:'🎬',title:'THE BIG SHORT SCREENING',text:'Brad Pitt explains subprime with a Jenga tower. Everyone watches. Nobody learns.',
 run(){setMood('FRENZY','The Big Short screens to a packed house');const bs=S.owner.bigshort;if(bs!=null)gain(bs,3,'packed house');const br=S.owner.brad;if(br!=null)gain(br,2,'he was right there on screen');const h=S.owner.hedge;if(h!=null)gain(h,2,'somebody was short the whole time');}},
{id:'madeout',icon:'🟣',title:'MADE PAYS OUT… PROBABLY',text:'The purple graphic does… something. Money appears. Explanations do not.',
 run(){setMood(S.mood,'MADE does… something');if(Math.random()<1/3){madePay();log('🟣 MADE has paid out. Nobody knows why. NOBODY.')}else log('🟣 MADE remains unexplained. Again.');}}
];
const CARDBYID={};CARDS.forEach(c=>CARDBYID[c.id]=c);
