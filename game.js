// カードバトル オンライン版 ゲームロジック（サーバー審判方式）
// 本体（単一HTML版）のルールをそのままサーバー側に移植したもの。
// - カード定義・デッキ構成・効果解決順・毒処理・山札切れ処理は本体と一致させる。
// - オンラインでは、ルームを作ったホストのカードセット（カード編集の内容を含む）を
//   サーバー側で検証・サニタイズして採用し、両プレイヤーが同じセットで戦う。
//   セットが送られなかった／不正だった場合は標準カードセットにフォールバックする。
// - 状態はサーバーが一元管理し、クライアントには viewFor() で
//   「そのプレイヤーが見てよい情報」だけを渡す（相手の手札は枚数のみ）。

const ELEMENTS = {
  '炎': '#d84a1f', '水': '#2478a6', '雷': '#c98f06', '土': '#8a6d3b',
  '闇': '#6c4a8a', '光': '#b8860b', '無': '#77705f',
};

// 本体の CARDS と同一（16種）
const CARDS = {
  flame_dragon: { name: 'フレイムドラゴン', el: '炎', glyph: '炎', cost: 4, text: 'ドラゴンの炎で攻撃。', fx: { dmg: 6 } },
  meteor:       { name: 'メテオストライク', el: '炎', glyph: '隕', cost: 6, text: '隕石を落とす大技。', fx: { dmg: 9 } },
  fireball:     { name: 'ファイアボール', el: '炎', glyph: '火', cost: 2, text: '火球を投げつける。', fx: { dmg: 3 } },
  seiren:       { name: 'ウォーターセイレン', el: '水', glyph: '水', cost: 3, text: '攻撃しつつ、自分を回復。', fx: { dmg: 3, heal: 3 } },
  ice_shield:   { name: 'フロストシールド', el: '水', glyph: '氷', cost: 2, text: '氷の盾で身を守る。', fx: { shield: 5 } },
  thunder:      { name: 'サンダーボルト', el: '雷', glyph: '雷', cost: 2, text: 'シールドを貫く電撃。', fx: { dmg: 3, pierce: true } },
  chain:        { name: 'ライトニングチェーン', el: '雷', glyph: '鎖', cost: 4, text: '攻撃して1枚ドロー。', fx: { dmg: 5, draw: 1 } },
  golem:        { name: 'アースゴーレム', el: '土', glyph: '岩', cost: 3, text: '岩の体でがっちり守る。', fx: { shield: 6 } },
  knight:       { name: 'ガードナイト', el: '土', glyph: '騎', cost: 3, text: '攻撃しながら盾も張る。', fx: { dmg: 2, shield: 3 } },
  assassin:     { name: 'シャドウアサシン', el: '闇', glyph: '影', cost: 3, text: '影から急所を貫く。', fx: { dmg: 5, pierce: true } },
  poison:       { name: 'ポイズンダガー', el: '闇', glyph: '毒', cost: 1, text: '毒を付与。相手ターン開始時に2ダメ×2回。', fx: { dmg: 1, poison: 2 } },
  fairy:        { name: 'ヒールフェアリー', el: '光', glyph: '癒', cost: 2, text: '妖精の粉で大きく回復。', fx: { heal: 6 } },
  regen:        { name: 'リジェネハーブ', el: '光', glyph: '葉', cost: 2, text: '回復して1枚ドロー。', fx: { heal: 3, draw: 1 } },
  potion:       { name: 'エナジードリンク', el: '無', glyph: '力', cost: 0, text: 'このターンのエネルギー+2。', fx: { energy: 2 } },
  slime:        { name: 'スライムパンチ', el: '無', glyph: '粘', cost: 1, text: 'ぷにっとした一撃。', fx: { dmg: 2 } },
  berserk:      { name: 'バーサーク', el: '無', glyph: '狂', cost: 3, text: '大ダメージ。ただし自分も1ダメ。', fx: { dmg: 5, selfdmg: 1 } },
};

// 本体の DECK_LIST と同一（32枚）
const DECK_LIST = [
  'flame_dragon', 'flame_dragon', 'meteor', 'fireball', 'fireball', 'fireball',
  'seiren', 'seiren', 'ice_shield', 'ice_shield', 'thunder', 'thunder', 'thunder',
  'chain', 'chain', 'golem', 'golem', 'knight', 'knight', 'assassin', 'assassin',
  'poison', 'poison', 'fairy', 'fairy', 'regen', 'potion', 'potion',
  'slime', 'slime', 'slime', 'berserk',
];

// ===== カードセットの検証・サニタイズ（本体の sanitizeCard / sanitizeImport をサーバー移植） =====
// ホストから送られた編集済みカードセットは、そのまま信用せず本体と同じ方針で検証する。
// - 属性は定義済みのものだけ、名前は24文字まで（空は不可）、アイコン2文字まで、説明80文字まで
// - コスト0〜8、効果数値は dmg/heal/shield 0〜15、poison 0〜5、draw 0〜3、energy 0〜4、selfdmg 0〜10 に丸める
// - デッキ枚数は1種0〜4枚。カードIDは [a-zA-Z0-9_-]{1,64} のみ許可
// サーバー側の追加ガードとして、カード種数は最大64種までに制限する。
const MAX_CARD_KINDS = 64;

function clampInt(v, min, max, fb) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fb || 0;
  return Math.max(min, Math.min(max, n));
}

function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const el = (typeof raw.el === 'string' && Object.prototype.hasOwnProperty.call(ELEMENTS, raw.el)) ? raw.el : '無';
  const name = typeof raw.name === 'string' ? raw.name.slice(0, 24).trim() : '';
  if (!name) return null;
  const glyph = typeof raw.glyph === 'string' && raw.glyph.trim() ? raw.glyph.slice(0, 2) : name.slice(0, 1);
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 80) : '';
  const cost = clampInt(raw.cost, 0, 8, 2);
  const rfx = (raw.fx && typeof raw.fx === 'object') ? raw.fx : {};
  const fx = {};
  const dmg = clampInt(rfx.dmg, 0, 15, 0); if (dmg) fx.dmg = dmg;
  const heal = clampInt(rfx.heal, 0, 15, 0); if (heal) fx.heal = heal;
  const shield = clampInt(rfx.shield, 0, 15, 0); if (shield) fx.shield = shield;
  const poison = clampInt(rfx.poison, 0, 5, 0); if (poison) fx.poison = poison;
  const draw = clampInt(rfx.draw, 0, 3, 0); if (draw) fx.draw = draw;
  const energy = clampInt(rfx.energy, 0, 4, 0); if (energy) fx.energy = energy;
  const selfdmg = clampInt(rfx.selfdmg, 0, 10, 0); if (selfdmg) fx.selfdmg = selfdmg;
  if (rfx.pierce === true) fx.pierce = true;
  return { name, el, glyph, cost, text: text || 'オリジナルカード。', fx };
}

// 送られてきたセット全体を検証する。使える形にならなければ null。
// 戻り値: { cards, deckCounts, deckList }
function sanitizeCardSet(data) {
  if (!data || typeof data !== 'object' || !data.cards || typeof data.cards !== 'object') return null;
  const rawCounts = (data.deckCounts && typeof data.deckCounts === 'object') ? data.deckCounts : {};
  const cleanCards = {}, cleanCounts = {};
  let idx = 0;
  for (const rawId of Object.keys(data.cards)) {
    if (Object.keys(cleanCards).length >= MAX_CARD_KINDS) break;
    const card = sanitizeCard(data.cards[rawId]);
    if (!card) continue;
    let id = /^[a-zA-Z0-9_-]{1,64}$/.test(rawId) ? rawId : `custom_import_${idx++}`;
    if (cleanCards[id]) id = `${id}_${idx++}`;
    cleanCards[id] = card;
    cleanCounts[id] = clampInt(rawCounts[rawId], 0, 4, 1);
  }
  if (Object.keys(cleanCards).length === 0) return null;
  const deckList = [];
  for (const id of Object.keys(cleanCards)) {
    for (let i = 0; i < cleanCounts[id]; i++) deckList.push(id);
  }
  if (deckList.length === 0) return null; // デッキが0枚になるセットは使えない
  return { cards: cleanCards, deckCounts: cleanCounts, deckList };
}

function sameCard(a, b) {
  if (a.name !== b.name || a.el !== b.el || a.glyph !== b.glyph || a.cost !== b.cost || a.text !== b.text) return false;
  const ka = Object.keys(a.fx), kb = Object.keys(b.fx);
  if (ka.length !== kb.length) return false;
  return ka.every(k => a.fx[k] === b.fx[k]);
}

// サニタイズ済みセットが標準セットと同一内容かどうか
function isStandardSet(cards, deckList) {
  const ids = Object.keys(CARDS);
  if (Object.keys(cards).length !== ids.length) return false;
  for (const id of ids) {
    if (!cards[id] || !sameCard(cards[id], CARDS[id])) return false;
  }
  if (deckList.length !== DECK_LIST.length) return false;
  const count = (list, id) => list.filter(x => x === id).length;
  return ids.every(id => count(deckList, id) === count(DECK_LIST, id));
}

// ルーム作成時に使うセットを決める。
// - raw が未指定（null/undefined）→ 標準セット（フォールバックではない）
// - raw が不正 → 標準セットにフォールバック（fallback: true。呼び出し側でホストへ通知する）
// - raw が有効 → サニタイズ済みセット。標準と同一内容なら custom: false
function resolveCardSet(raw) {
  if (raw == null) return { cards: CARDS, deckList: DECK_LIST, custom: false, fallback: false };
  const clean = sanitizeCardSet(raw);
  if (!clean) return { cards: CARDS, deckList: DECK_LIST, custom: false, fallback: true };
  return { cards: clean.cards, deckList: clean.deckList, custom: !isStandardSet(clean.cards, clean.deckList), fallback: false };
}

const START_HP = 30;
const START_HAND = 4;
const HAND_LIMIT = 8;
const MAX_ENERGY_CAP = 8;
const POISON_DAMAGE = 2;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let cardUid = 1;
function makeCard(defId) { return { uid: cardUid++, defId }; }

function makePlayer(name, deckList) {
  return {
    name,
    hp: START_HP, maxhp: START_HP, shield: 0, poison: 0,
    energy: 0, maxEnergy: 2,
    deck: shuffle((deckList || DECK_LIST).map(makeCard)), hand: [], discard: [],
  };
}

// set は resolveCardSet() の戻り値（{ cards, deckList, custom }）を想定。
// 未指定なら標準セットで作る。
function newGame(name1, set) {
  const s = (set && set.cards && set.deckList)
    ? set
    : { cards: CARDS, deckList: DECK_LIST, custom: false };
  const g = {
    phase: 'waiting', // waiting -> playing -> over
    cards: s.cards,       // この対戦で使うカード定義（ホストのセット or 標準セット）
    deckList: s.deckList, // デッキ構成（defId の配列）
    setCustom: !!s.custom, // ホストの編集セットかどうか
    players: [makePlayer(name1 || 'プレイヤー1', s.deckList)],
    turn: 0,
    turnCount: 0,
    winner: null, // 勝者の席番号（0/1）
    lastPlay: null, // { who, name, text }
    log: [], // { text, mark }
  };
  drawCards(g, g.players[0], START_HAND, true);
  return g;
}

function addLog(g, text, mark) {
  g.log.push({ text, mark: !!mark });
  if (g.log.length > 60) g.log.shift();
}

function startGame(g, name2) {
  const p2 = makePlayer(name2 || 'プレイヤー2', g.deckList);
  g.players.push(p2);
  drawCards(g, p2, START_HAND, true);
  g.phase = 'playing';
  addLog(g, `バトル開始！ ${g.players[0].name} vs ${p2.name}`, true);
  startTurn(g, true);
}

// 本体 drawCards の移植：山札切れ→捨て札再シャッフル、それも無ければ1ダメージ。
// 手札上限8枚を超える分は捨て札へ。
function drawCards(g, p, n, silent) {
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      if (p.discard.length > 0) {
        p.deck = shuffle(p.discard); p.discard = [];
        if (!silent) addLog(g, `${p.name} は捨て札をシャッフルして山札に戻した`);
      } else {
        p.hp -= 1;
        if (!silent) addLog(g, `${p.name} は山札切れで1ダメージ`);
        continue;
      }
    }
    const card = p.deck.pop();
    if (p.hand.length >= HAND_LIMIT) {
      p.discard.push(card);
      if (!silent) addLog(g, `${p.name} の手札が上限で ${g.cards[card.defId] ? g.cards[card.defId].name : card.defId} は捨て札に`);
    } else {
      p.hand.push(card);
    }
  }
}

// 本体 applyDamage の移植：貫通でなければシールドから吸収。
function applyDamage(target, amount, pierce) {
  let rest = amount;
  if (!pierce && target.shield > 0) {
    const absorbed = Math.min(target.shield, rest);
    target.shield -= absorbed; rest -= absorbed;
  }
  target.hp -= rest;
  return amount;
}

// 本体 startTurn の移植。
// isFirst は「試合の先手の初ターン」のときだけ true（その場合ドローしない）。
function startTurn(g, isFirst) {
  if (g.phase !== 'playing') return;
  const me = g.players[g.turn];
  g.turnCount++;
  me.maxEnergy = Math.min(MAX_ENERGY_CAP, me.maxEnergy + 1);
  me.energy = me.maxEnergy;
  addLog(g, `${me.name} のターン（ターン${Math.ceil(g.turnCount / 2)}）`, true);

  // 毒ダメージ（貫通2点、残り回数を1減らす）
  if (me.poison > 0) {
    me.poison--;
    const dealt = applyDamage(me, POISON_DAMAGE, true);
    addLog(g, `毒で ${me.name} に ${dealt} ダメージ`);
    if (checkEnd(g)) return;
  }
  if (!isFirst) {
    drawCards(g, me, 1, false);
    if (checkEnd(g)) return;
  }
  g.lastPlay = null;
}

function playCard(g, pi, handIndex) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  if (pi !== g.turn) return { error: '相手のターンです' };
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const card = me.hand[handIndex];
  if (!card) return { error: 'そのカードはありません' };
  const def = g.cards[card.defId];
  if (def.cost > me.energy) return { error: 'エネルギーが足りません' };

  me.energy -= def.cost;
  me.hand.splice(handIndex, 1);
  me.discard.push(card);
  g.lastPlay = { who: me.name, name: def.name, text: def.text };
  resolveCard(g, me, foe, def);
  checkEnd(g);
  return { ok: true };
}

// 本体 resolveCard の移植（効果の解決順も本体どおり：
// energy → shield → heal → dmg → poison → selfdmg → draw）
function resolveCard(g, me, foe, c) {
  const fx = c.fx, parts = [];
  if (fx.energy) { me.energy += fx.energy; parts.push(`エネルギー+${fx.energy}`); }
  if (fx.shield) { me.shield += fx.shield; parts.push(`シールド+${fx.shield}`); }
  if (fx.heal) {
    const before = me.hp;
    me.hp = Math.min(me.maxhp, me.hp + fx.heal);
    parts.push(`HP ${me.hp - before} 回復`);
  }
  if (fx.dmg) {
    const shBefore = foe.shield;
    applyDamage(foe, fx.dmg, !!fx.pierce);
    parts.push(`${foe.name} に ${fx.dmg} ダメージ${fx.pierce ? '（貫通）' : (shBefore > 0 ? '（盾で軽減）' : '')}`);
  }
  if (fx.poison) { foe.poison = Math.max(foe.poison, fx.poison); parts.push(`${foe.name} に毒`); }
  if (fx.selfdmg) { me.hp -= fx.selfdmg; parts.push(`自分も ${fx.selfdmg} ダメージ`); }
  if (fx.draw) { drawCards(g, me, fx.draw, false); parts.push(`${fx.draw}枚ドロー`); }
  addLog(g, `${me.name} の「${c.name}」： ${parts.join('、')}`);
}

function endTurn(g, pi) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  if (pi !== g.turn) return { error: '相手のターンです' };
  addLog(g, `${g.players[pi].name} はターン終了`);
  g.turn = 1 - g.turn;
  startTurn(g, false);
  return { ok: true };
}

// 降参：オンライン版では手番でなくても自分の意思で降参でき、降参した側の負け。
// （本体は「手番プレイヤーが降参＝そのプレイヤーの負け」という扱い。意味は同じ）
function surrender(g, pi) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  addLog(g, `${g.players[pi].name} が降参した`);
  g.players[pi].hp = 0;
  checkEnd(g);
  return { ok: true };
}

// 本体 checkEnd の移植：両者HP0なら手番プレイヤーの負け。
function checkEnd(g) {
  if (g.phase !== 'playing') return false;
  const [p0, p1] = g.players;
  if (p0.hp > 0 && p1.hp > 0) return false;
  g.phase = 'over';
  let loserIdx;
  if (p0.hp <= 0 && p1.hp <= 0) loserIdx = g.turn;
  else loserIdx = p0.hp <= 0 ? 0 : 1;
  g.winner = 1 - loserIdx;
  p0.hp = Math.max(0, p0.hp); p1.hp = Math.max(0, p1.hp);
  addLog(g, `${g.players[g.winner].name} の勝利！`, true);
  return true;
}

function restart(g) {
  const names = g.players.map(p => p.name);
  // 再戦でも同じカードセットを引き継ぐ
  const fresh = newGame(names[0], { cards: g.cards, deckList: g.deckList, custom: g.setCustom });
  Object.assign(g, fresh);
  startGame(g, names[1]);
}

// クライアントへ送る「そのプレイヤーから見た」状態。
// 自分の手札だけ中身を含み、相手は HP/シールド/毒/エネルギー/手札枚数/山札枚数のみ。
function viewFor(g, pi) {
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const pub = (p) => p ? ({
    name: p.name,
    hp: Math.max(0, p.hp), maxhp: p.maxhp,
    shield: p.shield, poison: p.poison,
    energy: p.energy, maxEnergy: p.maxEnergy,
    handCount: p.hand.length, deckCount: p.deck.length,
  }) : null;
  return {
    phase: g.phase,
    cardSet: { custom: !!g.setCustom }, // ホストの編集セットで対戦中かどうか
    turn: g.turn,
    turnNumber: Math.ceil(Math.max(1, g.turnCount) / 2),
    youAre: pi,
    isMyTurn: g.phase === 'playing' && g.turn === pi,
    winner: g.winner,
    winnerName: g.winner != null ? g.players[g.winner].name : null,
    turnCount: g.turnCount,
    me: me ? {
      ...pub(me),
      hand: me.hand.map(c => ({ uid: c.uid, defId: c.defId, ...g.cards[c.defId] })),
    } : null,
    foe: pub(foe),
    lastPlay: g.lastPlay,
    log: g.log.slice(-40),
  };
}

module.exports = {
  CARDS, DECK_LIST, ELEMENTS,
  newGame, startGame, playCard, endTurn, surrender, restart, viewFor,
  resolveCardSet, sanitizeCardSet,
  // テスト用に内部関数も公開
  _internal: { makePlayer, makeCard, drawCards, applyDamage, startTurn, checkEnd },
};
