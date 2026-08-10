import {
  asPlayerId,
  catalogueRegistry,
  type CardInstanceId,
  type GameAction,
  type GameEvent,
  type GameState,
  type MatchId,
  type PlayerId,
} from '@berserk/engine';
import { BANNER_HOLD_MS } from '@berserk/protocol';
import type { MatchManager } from './matches.js';

/**
 * The computer opponent.
 *
 * Femto plays to the shape of the game rather than to a script. Everything it
 * decides comes from one printed number — **Level** — because that is what
 * says when a card can be opened (Rules.md §7), and from the rhythm the rules
 * impose: set a card, open it on a later turn, one open per turn.
 *
 * What it decides:
 *  - whether an opening hand is worth keeping, and which cards to give back;
 *  - which card to set, and where;
 *  - which card to lose when it is over the hand limit.
 *
 *  - which Set Card to open, and what to spend paying for it;
 *  - when to attack, who leads, who joins, and where the damage goes.
 *
 * What it cannot decide yet, and why:
 *  - **Moving with purpose.** It sets and opens where it is thinnest, but does
 *    not march characters toward a city it wants.
 *
 * It plays through `MatchManager.submitAction`, the same path a human takes,
 * so every move it makes is checked by the engine. `chooseAction` is a pure
 * function of the state and the legal actions, which is what makes its
 * judgement testable.
 */

export const AI_PLAYER_ID: PlayerId = asPlayerId('ai-femto');
export const AI_NAME = 'Femto';

/**
 * How long Femto waits after each kind of move, so a human can follow what it
 * did rather than watch a turn happen at once.
 *
 * These are per-*action*, because the moves are not equally worth watching. A
 * card being set has to fly from a hand and land somewhere specific, and the
 * player needs a moment on it afterwards to see *where*. Ending a phase is
 * just the marker moving. Anything that redraws the board gets the longest
 * pause of all.
 *
 * The card slide is 620ms (`useCardFlip`), so nothing here should be shorter
 * than that or the next move starts while the last one is still moving.
 */
const PAUSE_MS: Partial<Record<GameAction['type'], number>> = {
  SET_CARD: 1500,
  DECLARE_BATTLE: 1400,
  DESIGNATE_VANGUARD: 1400,
  COMMIT_CHARACTER: 1300,
  ASSIGN_DAMAGE: 1600,
  BATTLE_PASS: 1000,
  PASS_PRIORITY: 900,
  MOVE_CHARACTER: 1500,
  OPEN_CARD: 1800,
  DISCARD_CARD: 1100,
  // A card leaving hand or coming out of the deck, one at a time. Paced like
  // the discard above, because it looks the same from the other side of the
  // table: a card moving with no other explanation.
  CHOOSE_CARD: 1100,
  END_PHASE: 850,
};
/** Anything not listed above. */
const DEFAULT_PAUSE_MS = 900;
/**
 * The wait before the first move of a turn.
 *
 * Long enough to outlast the banner announcing the turn, because a card
 * sliding out from under an overlay is a move the player never sees. The
 * banner's own length is shared through the protocol, so raising it there
 * moves this too rather than leaving Femto playing early.
 */
const LEAD_IN_MS = BANNER_HOLD_MS + 200;
/** Stops a rules bug from spinning the AI forever. */
const MAX_ACTIONS = 200;

/**
 * A card at this Level or below can be opened in the game's first turns, when
 * City Level is still low (Rules.md §5, §7). A hand of nothing else is a hand
 * that cannot act.
 */
const EARLY_LEVEL = 2;
/** How many early cards make an opening hand worth keeping. */
const EARLY_WANTED = 2;
/**
 * Never mulligan below this. Each one costs another card off the top
 * (DesignNotes 5), and a smaller hand is also less cost to pay with.
 */
const MIN_WORTH_KEEPING = 5;
/**
 * How many cards Femto sets in a turn.
 *
 * Rules.md §10 ④(2) allows any number. The cap is a judgement, not a rule:
 * only one card can be *opened* per turn (§10 ③), and cards in hand are what
 * pay for opening (§7), so a hand emptied onto the table cannot afford what
 * it put there.
 *
 * Two early, one after that. A Set Card is a threat the opponent must read
 * face-down and a claim on an area they have to answer, so the first turns —
 * when there is nothing to answer with and the hand refills from a full
 * deck — are cheap ones to spend spreading out. Later the hand is the
 * bottleneck and every card set is a cost that cannot be paid.
 */
const EARLY_SETS_PER_TURN = 2;
const SETS_PER_TURN = 1;
/** Turns counted as "early" for the wider set limit above. */
const EARLY_TURNS = 3;

/**
 * The Level-0 body every deck carries ten of (`Docs/Deckbuilding.md`).
 *
 * Matched by printed name, which is the deckbuilding rule — the `mercenary`
 * *subtype* is the faction on the type line and is a different set of cards.
 */
const MERCENARY = 'Mercenary';

const REGISTRY = catalogueRegistry();

export const isAi = (playerId: PlayerId): boolean => playerId === AI_PLAYER_ID;

/**
 * How soon a card could be opened. Lower is better, and unknown is worst:
 * a card whose Level was never read off the scan cannot be opened at all,
 * so it is the first thing Femto gives up.
 */
function levelOf(state: GameState, cardId: CardInstanceId): number {
  const card = state.cards[cardId];
  if (!card || !REGISTRY.has(card.defId)) return Number.POSITIVE_INFINITY;
  return REGISTRY.get(card.defId).level ?? Number.POSITIVE_INFINITY;
}

/** The hand as instance ids, in zone order. */
function hand(state: GameState, player: PlayerId): readonly CardInstanceId[] {
  return state.zoneOrder[`${player}:hand`] ?? [];
}

/** The printed name of a card, or null where the scan never yielded one. */
function nameOf(state: GameState, cardId: CardInstanceId): string | null {
  const card = state.cards[cardId];
  if (!card || !REGISTRY.has(card.defId)) return null;
  return REGISTRY.get(card.defId).name ?? null;
}

const isMercenary = (state: GameState, cardId: CardInstanceId): boolean =>
  nameOf(state, cardId) === MERCENARY;

/**
 * Is Femto on the back foot of the turn order? Rules.md §9.2, §10 ②.
 *
 * `seats[0]` goes first and skips their first draw. It matters for what to
 * set on turn one: the player going second reaches their first Open step with
 * a City Level the *first* player has usually already raised, so a Level 1
 * card is openable there while a Level 0 Mercenary would have been openable
 * either way. Setting the thing that only just became affordable is strictly
 * better than setting the thing that was always affordable.
 */
const goingSecond = (state: GameState, player: PlayerId): boolean => state.seats[1] === player;

/**
 * How many cards a player has committed to a city.
 *
 * Presence, not Power: this answers "is anybody there" for deciding where to
 * put a card down, which is a different question from who would win a fight.
 *
 * `faceUp` picks out which cards count, and it differs by side. Femto's own
 * face-down Set Cards count — it knows what they are, and a card already
 * committed to an area is a reason to spread the next one elsewhere. The
 * opponent's do not: only a face-up character contests an area (Rules.md §5),
 * and counting their face-down cards would be reading information the engine
 * redacts from a player anyway.
 */
function presence(
  state: GameState,
  city: number,
  player: PlayerId,
  options: { faceUpOnly: boolean },
): number {
  return Object.values(state.cards).filter(
    (card) =>
      card.zone === 'city' &&
      card.cityIndex === city &&
      card.controller === player &&
      (!options.faceUpOnly || card.faceUp),
  ).length;
}

/**
 * Where to put a card down.
 *
 * Three things decide it, in order.
 *
 * **The Royal Capital outranks everything.** It is one of the three cities
 * needed to win and the win is impossible without it (Rules.md §1), so an
 * area known to be the Capital is worth contesting even when it is crowded.
 * It is only *known* once the city is face up (§5) — face-down it could be
 * any of the five, and spreading is what covers that.
 *
 * **Then somewhere uncontested.** A card set where the opponent has nobody
 * can be opened and can take the area without a fight, which is the cheapest
 * board presence in the game. An area they already hold has to be won through
 * a battle, so it is worth less per card put into it.
 *
 * **Then spread.** Femto's own cards already there count against an area:
 * five thin claims cover more of a face-down row than one deep stack, and
 * only one of those areas is the Capital. Ties go to the middle, which is
 * within Move range of more of the row than either end.
 */
function bestCity(state: GameState, player: PlayerId, offered: readonly number[]): number | null {
  const enemy = enemyOf(state, player);
  const centre = (state.cities.length - 1) / 2;

  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const index of offered) {
    const city = state.cities[index];
    if (!city) continue;

    // Weights are spaced so each beats every combination of the ones below
    // it: the Capital outranks any amount of crowding, and being unopposed
    // outranks any tie-break on position.
    let score = 0;
    if (city.faceUp && city.royalCapital) score -= 10_000;
    // Somewhere they are not, or somewhere they are but do not yet hold.
    score += presence(state, index, enemy, { faceUpOnly: true }) * 400;
    if (city.occupiedBy === enemy) score += 600;
    score += presence(state, index, player, { faceUpOnly: false }) * 100;
    score += Math.abs(index - centre);

    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

/** The action of `type` whose card scores best under `rank` (lowest wins). */
function pickCard(
  actions: readonly GameAction[],
  type: 'SET_CARD' | 'DISCARD_CARD' | 'BOTTOM_CARD' | 'CHOOSE_CARD',
  rank: (card: CardInstanceId) => number,
): GameAction | null {
  let best: GameAction | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const action of actions) {
    if (action.type !== type || !('card' in action)) continue;
    const score = rank(action.card);
    if (score < bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

/**
 * Picks Femto's next move.
 *
 * Deliberately never concedes: an opponent that gives up should let the human
 * play the match out, not end it.
 */
export function chooseAction(
  state: GameState,
  actions: readonly GameAction[],
  player: PlayerId = AI_PLAYER_ID,
): GameAction | null {
  const has = (type: GameAction['type']): boolean => actions.some((a) => a.type === type);
  const worst = (card: CardInstanceId): number => -levelOf(state, card);
  const soonest = (card: CardInstanceId): number => levelOf(state, card);

  // An effect has stopped and is waiting on Femto to name cards (§13). It
  // outranks everything below, including a Quick window and a running battle,
  // because until it is answered nothing else is legal at all.
  //
  // Which card follows what the question is for. Pitching from hand gives up
  // what it could open latest, the same judgement it uses at the hand limit;
  // searching the deck takes the biggest thing it found, since a search is a
  // free pick and the cheap cards will come round again on their own.
  if (state.pending?.waitingOn === player) {
    const picks = actions.filter(
      (action): action is Extract<GameAction, { type: 'CHOOSE_CARD' }> =>
        action.type === 'CHOOSE_CARD',
    );
    if (picks.length === 0) return null;
    // Pitching gives up the card it could open latest — `worst`, the same
    // judgement it uses at the hand limit. Searching wants the opposite end of
    // that ordering: a search is a free pick, and the cheap cards will come
    // round on their own, so it takes what it could open soonest and can
    // therefore actually use.
    const rank = state.pending.kind.zone === 'hand' ? worst : soonest;
    return pickCard(picks, 'CHOOSE_CARD', rank);
  }

  // Being asked whether to answer with a Quick (Rules.md §13).
  //
  // Femto takes the biggest one it is offered, on the same reasoning as its
  // ordinary opens: a Quick it declines is one it may never get to use, since
  // the window will not come round again. It only ever sees this when it has
  // one set and can pay, so there is no judgement about *whether* to hold.
  if (state.quick?.waitingOn === player) {
    const opens = actions.filter(
      (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> => action.type === 'OPEN_CARD',
    );
    const best = opens.sort((a, b) => levelOf(state, b.card) - levelOf(state, a.card))[0];
    return best ?? { type: 'PASS_PRIORITY' };
  }

  // Owed to the bottom after keeping: give back what it could open latest.
  if (has('BOTTOM_CARD')) return pickCard(actions, 'BOTTOM_CARD', worst);

  // Keep or mulligan. A hand with nothing cheap in it cannot open anything
  // while City Level is low, and is worth trading — but only while trading is
  // still cheap.
  if (has('KEEP_HAND')) {
    const cards = hand(state, player);
    const early = cards.filter((card) => levelOf(state, card) <= EARLY_LEVEL).length;
    const target = state.handTarget[player] ?? cards.length;
    if (early < EARLY_WANTED && target > MIN_WORTH_KEEPING && has('MULLIGAN')) {
      return { type: 'MULLIGAN' };
    }
    return { type: 'KEEP_HAND' };
  }

  // Over the hand limit (Rules.md §10 ⑤): lose the card it could open latest.
  if (has('DISCARD_CARD')) return pickCard(actions, 'DISCARD_CARD', worst);

  // One open per turn is the game's bottleneck (Rules.md §10 ③), so the one
  // taken should be the biggest thing affordable: a Set Card sitting unopened
  // does nothing, and the turn's open cannot be banked for later.
  //
  // Ties go to the cheapest payment, because every card spent on a cost is a
  // card not available to pay the next one (§7).
  const opens = actions.filter(
    (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> => action.type === 'OPEN_CARD',
  );
  if (opens.length > 0) {
    let best = opens[0]!;
    for (const option of opens) {
      const better = levelOf(state, option.card) - levelOf(state, best.card);
      if (better > 0 || (better === 0 && option.pay.length < best.pay.length)) best = option;
    }
    return best;
  }

  // A battle is running and waiting on Femto. Rules.md §11.
  const battle = state.battle;
  if (battle) return fight(state, actions, battle, player);

  // Attack. Rules.md §10 ④(4).
  //
  // Winning the exchange is the usual reason, but it is not the only one. An
  // *unheld* area is taken by fighting over it at all — §12 reads the result
  // off the characters committed, and an attacker who shows up against a
  // defender with nobody to commit takes it. So the bar is "can this be won",
  // not "is my stack bigger", and an empty area clears it outright.
  //
  // The Capital is worth attacking into on worse odds than anywhere else,
  // because it is the one area the game cannot be won without (§1).
  const attacks = actions.filter(
    (action): action is Extract<GameAction, { type: 'DECLARE_BATTLE' }> =>
      action.type === 'DECLARE_BATTLE',
  );
  const worthAttacking = attacks
    .map((attack) => {
      const city = state.cities[attack.city];
      const mine = powerIn(state, attack.city, player);
      const theirs = powerIn(state, attack.city, enemyOf(state, player));
      const capital = city?.faceUp === true && city.royalCapital;
      // Trading evenly into the Capital is worth it; trading evenly anywhere
      // else spends two characters to move nothing.
      const winnable = capital ? mine >= theirs : mine > theirs;
      return { attack, capital, margin: mine - theirs, winnable };
    })
    .filter((option) => option.winnable)
    // The Capital first, then the fight it wins by the most.
    .sort((a, b) => Number(b.capital) - Number(a.capital) || b.margin - a.margin);

  const best = worthAttacking[0];
  if (best) return best.attack;

  // Put a card down. `driveAi` stops offering this once Femto has set its
  // allowance for the turn.
  if (has('SET_CARD')) {
    const card = pickCard(actions, 'SET_CARD', setPriority(state, player));
    if (card && card.type === 'SET_CARD') {
      const cities = actions
        .filter((a) => a.type === 'SET_CARD' && a.card === card.card)
        .map((a) => (a as Extract<GameAction, { type: 'SET_CARD' }>).city);
      const city = bestCity(state, player, cities);
      if (city !== null) return { type: 'SET_CARD', card: card.card, city };
    }
  }

  return actions.find((action) => action.type === 'END_PHASE') ?? null;
}

/**
 * Which card to set, as a rank where lower wins.
 *
 * Ordinarily "whatever opens soonest", because a Set Card that cannot be
 * opened is a card face-down doing nothing. Two things bend that.
 *
 * **Going second, on the first turn, prefer Level 1 over Level 0.** The
 * player going second reaches their first Open step *after* the opener has
 * had a turn, so City Level has usually already risen to 1 (Rules.md §5, §7)
 * — and a Level 1 card is a bigger body for the same single open. Setting the
 * Mercenary there would spend the turn's set on something that was openable
 * either way. Only Level 1: Level 2 is a guess about a level that has not
 * been reached yet, and a card that cannot be opened is worse than one that
 * can.
 *
 * **Early on, prefer Mercenaries.** They are Level 0, so they open under any
 * City Level, and every deck carries ten (`Docs/Deckbuilding.md`) — which
 * makes them the cards to spend on claiming areas while the areas are still
 * unclaimed. Spreading cheap bodies early is what creates the uncontested
 * opens later, and holding them back achieves nothing: they never get better.
 */
function setPriority(state: GameState, player: PlayerId): (card: CardInstanceId) => number {
  const turn = state.turn.turnNumber;
  const firstTurn = turn <= 1;
  const early = turn <= EARLY_TURNS;
  const second = goingSecond(state, player);

  return (card: CardInstanceId): number => {
    const level = levelOf(state, card);

    // The first turn going second: the open that is about to be available is
    // a Level 1 one, so set for that rather than for the level on the table.
    if (firstTurn && second && level === 1) return -100;

    // Early: a Level 0 Mercenary is a claim that can always be cashed.
    if (early && isMercenary(state, card)) return -50;

    return level;
  };
}

/** Total Power a player has standing in a city — the crude measure of a fight. */
function powerIn(state: GameState, city: number, player: PlayerId): number {
  return Object.values(state.cards)
    .filter(
      (card) =>
        card.zone === 'city' &&
        card.cityIndex === city &&
        card.faceUp &&
        card.controller === player,
    )
    .reduce((sum, card) => {
      const def = REGISTRY.has(card.defId) ? REGISTRY.get(card.defId) : null;
      return sum + (def?.stats?.power ?? 0);
    }, 0);
}

const enemyOf = (state: GameState, player: PlayerId): PlayerId =>
  state.seats.find((seat) => seat !== player) ?? player;

/** Power of one character, or 0 if it has none. */
function powerOf(state: GameState, id: CardInstanceId): number {
  const card = state.cards[id];
  if (!card || !REGISTRY.has(card.defId)) return 0;
  return REGISTRY.get(card.defId).stats?.power ?? 0;
}

/**
 * Femto's part in a battle. Rules.md §11.
 *
 * Both sides feed characters in while they are behind on Power and stop once
 * they are ahead, because every extra body past that is one more that can be
 * killed for nothing.
 *
 * Defending is not optional in the way it looks: §12 counts only the
 * characters that fought, so a defender who commits nobody loses the city
 * however many are standing in it. Being behind therefore means losing the
 * city, not just the fight — which is exactly when it commits.
 */
function fight(
  state: GameState,
  actions: readonly GameAction[],
  battle: GameState['battle'],
  player: PlayerId,
): GameAction | null {
  if (!battle) return null;
  const pass = actions.find((action) => action.type === 'BATTLE_PASS') ?? null;
  const strongest = <T extends { card: CardInstanceId }>(of: readonly T[]): T | undefined =>
    [...of].sort((a, b) => powerOf(state, b.card) - powerOf(state, a.card))[0];

  switch (battle.step) {
    case 'vanguard': {
      const leads = actions.filter(
        (action): action is Extract<GameAction, { type: 'DESIGNATE_VANGUARD' }> =>
          action.type === 'DESIGNATE_VANGUARD',
      );
      return strongest(leads) ?? pass;
    }

    case 'opens': {
      // §11 ② — the combat open is *free*. It does not touch the one open a
      // turn (§10 ③), so a card flipped here is board presence that cost
      // nothing but its price in cards, and Femto used to decline it every
      // time on reasoning that only applies to the turn's open.
      //
      // Worth taking even in a fight it will lose. §11 ③ makes committing a
      // separate choice from opening, so a character can come down, stay out
      // of the battle, and still be standing in the area afterwards — and the
      // area is lost anyway if the fight was already lost. The one thing that
      // would waste it is opening into a battle it is *winning*, where the
      // card was never needed; that is still worth doing, because the card is
      // on the board either way and the area is about to be held.
      const combatOpens = actions.filter(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD',
      );
      // Biggest first, and ties to the cheapest payment — the same judgement
      // as the turn's own open.
      const best = [...combatOpens].sort(
        (a, b) => levelOf(state, b.card) - levelOf(state, a.card) || a.pay.length - b.pay.length,
      )[0];
      return best ?? pass;
    }

    case 'commit': {
      const joins = actions.filter(
        (action): action is Extract<GameAction, { type: 'COMMIT_CHARACTER' }> =>
          action.type === 'COMMIT_CHARACTER',
      );
      if (joins.length === 0) return pass;

      const committed = (side: PlayerId): number =>
        battle.participants
          .filter((id) => state.cards[id]?.controller === side)
          .reduce((sum, id) => sum + powerOf(state, id), 0);

      const mine = committed(player);
      const theirs = committed(enemyOf(state, player));
      const best = strongest(joins);
      if (!best) return pass;

      // Already ahead: every extra body is one more that can be killed for
      // nothing (§11 ④).
      if (mine > theirs) return pass;

      // Behind, and this is the Capital: keep feeding. It is the one area the
      // game cannot be won without (§1), so losing it costs more than the
      // characters spent holding it.
      const city = state.cities[battle.city];
      if (city?.faceUp === true && city.royalCapital) return best;

      // Behind anywhere else: only join if this character actually turns the
      // fight. Throwing one more into a battle it still loses spends a
      // character to change nothing — §12 reads the result off who fought, so
      // a body that does not close the gap dies for an area already lost.
      // Declining leaves it standing there for next turn.
      return mine + powerOf(state, best.card) > theirs ? best : pass;
    }

    case 'damage': {
      // The engine offers one legal split, concentrated on a single enemy,
      // which is the assignment most likely to destroy something.
      return actions.find((action) => action.type === 'ASSIGN_DAMAGE') ?? null;
    }
  }
}

/** Matches the AI is already playing, so its turns cannot overlap. */
const running = new Set<MatchId>();

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays the AI's turn, if it is the AI's turn.
 *
 * Returns once the AI no longer has anything to do — because play passed back
 * to the human, or the match ended. `onChange` fires after each move, carrying
 * that move's events: without them the client's feed would be blind to
 * everything the computer does, and anything driven by events — the card held
 * up on an open, the sound of a draw — would only ever fire for the human.
 *
 * The per-turn set limit lives here rather than in `chooseAction`, so that
 * function stays a pure reading of the position with no memory of its own.
 */
export async function driveAi(
  matches: MatchManager,
  matchId: MatchId,
  onChange: (events: readonly GameEvent[]) => void,
): Promise<void> {
  if (running.has(matchId)) return;
  running.add(matchId);

  let setsThisTurn = 0;
  let lastTurn = -1;
  let waited = false;

  try {
    for (let step = 0; step < MAX_ACTIONS; step++) {
      const match = matches.get(matchId);
      const state = match?.state;
      if (!state || state.status.kind === 'finished') return;

      // In setup both players decide independently, so the AI acts whenever it
      // still owes a decision. In play it acts only when it holds priority.
      // A battle answers to its own steps rather than to priority: the
      // defender acts throughout the attacker's turn (Rules.md §11), so
      // waiting for priority here would hang the match.
      const owed =
        state.status.kind === 'setup'
          ? state.mulliganPending.includes(AI_PLAYER_ID)
          : // An effect that stopped to ask outranks everything, including a
            // window and a battle (Rules.md §13) — and like them, missing it
            // hangs the match: nobody else may act until it is answered.
            state.pending
            ? state.pending.waitingOn === AI_PLAYER_ID
            : // A Quick window stops the game and names who it is waiting on,
              // whoever's turn it is (Rules.md §13). Missing this hangs the
              // match outright: nobody else may act until it is answered.
              state.quick
              ? state.quick.waitingOn === AI_PLAYER_ID
              : state.battle
                ? state.battle.waitingOn === AI_PLAYER_ID
                : state.turn.priorityPlayer === AI_PLAYER_ID;
      if (!owed) return;

      if (state.turn.turnNumber !== lastTurn) {
        lastTurn = state.turn.turnNumber;
        setsThisTurn = 0;
      }

      // Once per turn, before doing anything: this call *is* the AI's turn,
      // so the wait belongs on its first pass. Keying it off the turn number
      // does not work — the number only advances when play comes back round
      // to the starting player, so it never changes when the turn passes from
      // the human to the AI.
      //
      // Not during setup: mulligans announce nothing, so there is nothing to
      // wait for and the human is already waiting on the deal.
      if (!waited) {
        waited = true;
        if (state.status.kind === 'playing') await pause(LEAD_IN_MS);
      }

      // Wider early, when spreading cheap bodies over a face-down row is what
      // buys uncontested opens later; narrower after that, when the hand is
      // the bottleneck and a card set is a cost that cannot be paid.
      const allowance = state.turn.turnNumber <= EARLY_TURNS ? EARLY_SETS_PER_TURN : SETS_PER_TURN;
      let legal = matches.legalActions(matchId, AI_PLAYER_ID);
      if (setsThisTurn >= allowance) {
        legal = legal.filter((action) => action.type !== 'SET_CARD');
      }

      const action = chooseAction(state, legal);
      if (!action) return;

      const result = matches.submitAction(matchId, AI_PLAYER_ID, action);
      if (!result.ok) return;
      if (action.type === 'SET_CARD') setsThisTurn++;

      onChange(result.events);
      await pause(PAUSE_MS[action.type] ?? DEFAULT_PAUSE_MS);
    }
  } finally {
    running.delete(matchId);
  }
}
