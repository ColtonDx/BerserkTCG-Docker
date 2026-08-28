# Berserk Trading Card Game — Rules Reference

_Konami, 2003 (based on Kentaro Miura's_ Berserk*). Translated and reorganized from the original Japanese Official Rulebook (公式ルールブック).*

---

## 1. Goal of the Game

Two players fight over a shared row of **City (Area) cards** placed between them. You win by meeting **either** condition:

- **Occupy 3 or more cities at once, including the Royal Capital (王都).** The other cities are Local Cities.
- **Your opponent cannot draw** — if a player is required to draw from an empty deck, they lose.

---

## 2. What You Need

**Main deck** — 45 cards or more, built within these limits:

- No more than **3 copies** of any single card (same card number).
- **Exception:** Mercenary (傭兵) cards may be included in any quantity.
- You must include **at least 10 Mercenary cards.**

**City cards** — 5 total, shared between both players, one of which is the **Royal Capital**. Used together, not per-player.

**An opponent** — the game is strictly 2-player.

---

## 3. The Two Card Types

### Character cards (キャラクターカード)

Your fighters. Used to battle and occupy cities. Key stats:

| Stat           | Japanese    | Meaning                                                           |
| -------------- | ----------- | ----------------------------------------------------------------- |
| **Move**       | 移動        | How many cities the character can travel in one move.             |
| **Range**      | 射程        | Attack priority — higher Range deals its damage first in battle.  |
| **Power / HP** | 戦闘力 / HP | Power = damage dealt. HP = damage it can take before destruction. |

- **Damage resets to 0 at end of turn**, so survivors "heal" between turns.
- A character that takes **damage ≥ its HP** in a turn is sent to the Trash immediately.

### Effect cards (エフェクトカード)

Non-character cards recreating scenes from the series. Two kinds:

- **Normal Effect** — resolves its effect once when used, then goes to the Trash.
- **Eternal Effect** (エターナル) — stays on the field like a character, providing an ongoing special ability.

### Card colors

Every character and effect card is one of **4 colors**: White, Green, Black, Red. Color is referenced when paying costs.

---

## 4. Card Data & Marks

Character card fields: ① Card Name · ② Cost · ③ Level · ④ Color · ⑤ Type · ⑥ Range · ⑦ Move · ⑧ Power/HP · ⑨ Special Ability · ⑩ Card No.

- **Level (Lv.)** — higher-Level cards are stronger but harder to bring out (see City Level gating). The mark after the Level shows **rarity**.
- **Rarity marks:** Rare (rarest) → Uncommon → Common (most frequent).
- **Cost** — shown as colored icons next to the Level (see §7).

---

## 5. City Cards & City Level

Cities are the battleground. **City Level (都市Lv.)** is a single, shared value = the number of face-up City cards showing anywhere on the table. It is **not** tracked per city — flipping any city raises the level for opening cards in every city.

- At game start every city is **face-down**, so all cities are **City Lv. 0**.
- A city is turned face-up (raising the Level) **when a battle commences over it** — the moment the attacker names a vanguard (§11 ①), not the declaration before it, which can still be called off. Being fought over is what wakes a city; merely opening a character there does not.
- Once face-up a city **stays** face-up for the rest of the match, whoever ends up holding it. City Level therefore only ever climbs.

City Level is the gate that controls which cards you can open (see §7).

---

## 6. Card States: Unlocked & Locked

- **Unlocked (アンロック)** — card stands vertical. Cards enter play unlocked.
- **Locked (ロック)** — card turned horizontal. A card becomes locked after taking an action that requires it.

Cards **unlock during your Refresh phase**. Some actions require a card to be unlocked and lock it as a cost (moving, committing to battle); some actions don't lock.

---

## 7. Using Cards: Set, then Open

**Every card must first be Set face-down, then Opened on a later turn.** This is the central rhythm of the game.

- A face-down card in a city's lane is a **Set Card (セットカード).**
- You can always check your own Set Cards; you cannot see your opponent's.
- **Opening** a card = flipping it face-up and paying its cost.

**Two conditions must be met to open a card:**

1. **Level gate** — the card's Level must be **≤ the current City Level**, i.e. the number of face-up cities on the table. (City Lv. 3 → you may open Lv. 0–3 cards, in any city.)
2. **Pay the cost.**

**Paying cost** — the cost shows colored icons. Move that many cards of the shown color from your **hand** to the **Trash**:

| Icon                             | Pays with                                     |
| -------------------------------- | --------------------------------------------- |
| White / Green / Black / Red icon | A card of that color                          |
| **Multi icon** (number)          | Any color; the number = how many cards to pay |

> **Q — Opening a card above City Level?** If you open a card whose Level is higher than the City Level, it simply becomes a Set Card again, and **you do not pay the cost.**

---

## 8. Unique Cards

Some cards that stay on the field have the **Unique (固有)** trait.

- Only **one** card of a given name may exist on the field at a time.
- If a card of the same name is already on the field (yours **or** your opponent's), you **cannot open** another copy.

---

## 9. Game Setup

1. Shuffle the City cards and lay them **face-down, horizontal**, in a row (all neutral, City Lv. 0).
2. Randomly determine who goes first (e.g. rock-paper-scissors).
3. Each player shuffles their deck and draws an opening hand of **7**.
4. **Mulligan (hand exchange):** if you dislike your hand, return it to the deck, shuffle, and draw **one fewer** card than before. Repeatable any number of times, losing one card each time.

---

## 10. Turn Structure

Each turn has **5 phases**:

### ① Refresh phase (回復フェイズ)

Unlock all your locked cards (return them to vertical).

### ② Draw phase (ドローフェイズ)

Draw 1 card. **Skip on the first player's first turn.**

### ③ Open phase (オープンフェイズ)

You may open **one** of your Set Cards, paying its cost.

> **This one-open-per-turn limit is the game's core bottleneck.** A set card normally can't act until the turn after it was set. Finding ways to open more (combat, Quick) is central strategy.

### ④ Main phase (メインフェイズ)

Do any of the following, in any order, any number of times:

1. **Move a character** — choose one **unlocked** character and a destination city within its **Move** range; **lock it** and move it.
2. **Set a card** — place one card from hand face-down in any city.
3. **Use a special ability** — activate a character/Eternal ability.
4. **Declare battle** — choose a city you do **not** occupy and declare battle. **Once per city per turn**, counted from the moment a vanguard is named (§11 ①) rather than from the declaration — an attack called off before it starts leaves the city attackable again. Resolves the Battle phase, then returns to Main.

### ⑤ End phase (終了フェイズ)

- All characters' damage becomes 0.
- If your hand has **8+ cards**, discard down to **7**.
- Turn passes to the opponent.

---

## 11. The Battle Phase

Declared during the Main phase against a city you don't occupy. Five steps in fixed order:

### ① Vanguard Designation (先陣キャラクター指定)

The attacker designates one friendly character in that city and **locks** it — it becomes the lead battle participant. **If no vanguard is designated, the Battle phase ends** and you return to Main.

Naming the vanguard is what **commits** the attack: it spends that city's one battle for the turn (§10 ④(4)) and turns the city face up (§5). Backing out before it costs nothing and reveals nothing — the city stays face down and may be attacked again this turn: nothing has been locked, opened, struck or shown yet, and this step exists precisely to offer the way out.

The **vanguard** is the character that started the attack: it was already on the field when the battle was declared, and it is chosen before ② — so a character opened _during_ the combat step can join the battle (③) but can never be the vanguard. Card abilities that read "if it is the vanguard" mean exactly this one character.

### ② Combat Open (戦闘オープンステップ)

- **(1) Defender** may open one of _their_ Set Cards in this city — resolves — _(opening is optional)_.
- **(2) Attacker** may open one of _their_ Set Cards in this city — resolves.

Each side gets **one** open here, **defender first, then attacker**, each resolving before the next. (Quick effects can still interject — see §13.)

### ③ Battle Character Designation (戦闘キャラクター指定)

Players alternate **attacker → defender**, each committing one character at a time (locking it) to join the battle. Continue until both pass consecutively.

> **Occupying-defender exception:** if the defender **occupies** the contested city, **all** their characters there are **automatically committed — even locked ones.** Lock state is irrelevant for defending a city you occupy.

### ④ Damage Exchange (ダメージ応酬)

- Starting with the **highest-Range** character, assign its **Power** as damage among enemy participants' HP.
- Resolve, then the next-highest Range assigns and resolves, and so on.
- **Ties in Range:** the attacker assigns first, but damage resolves **simultaneously.**
- A character taking damage ≥ its HP is destroyed (to Trash) and, once destroyed, deals no damage.

### ⑤ Battle End (戦闘終了)

Apply the battle result (below), then return to the Main phase.

---

## 12. Battle Results

| Result                 | Japanese | Condition                                               | Outcome                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Occupation**         | 占領     | Only the **attacker's** characters remain in the battle | Attacker occupies it. Turn the city card to face the occupier. **The occupier draws 2 cards** (city card's effect). |
| **Repel**              | 撃退     | Only the **defender's** characters remain               | Attack fails. **No occupation** (you only occupy by attacking successfully).                                        |
| **Draw / Stalemate**   | 引き分け | Both players still have characters in the battle        | No change. A prior occupier keeps the city.                                                                         |
| **Mutual Destruction** | 全滅     | Neither player has characters left in the battle        | City becomes neutral.                                                                                               |

**Notes:**

- **Only participants count.** The result is read off the characters that were
  committed to the battle, not everyone standing in the city. A defender may
  take their combat open, look at what is coming, and then commit nobody —
  their other characters stay where they are, untouched, and the city is taken.
  Declining to fight is a real choice with a real cost.
- The **draw-2 on occupation** comes from the City card's effect and triggers at **Battle End**, the moment occupation is established. Retaking a city is a fresh occupation and draws again; merely holding a city you already own does not.
- A city becomes **neutral** if the occupier ever has no characters there (through movement, battle, etc.).
- You **can** attack a city the opponent occupies — they must commit their whole garrison to defend (auto-commit). Win and you seize it.

---

## 13. Special Abilities

Abilities on characters and Eternal Effects. Active only while the card is on the field.

- **Cost-bearing abilities** — cost and effect are separated by `/`; the left side is the cost (paid from hand → Trash). **Usable only in your own Main phase** — _unless_ the ability has **Quick**.
- **Cost-free abilities** — resolve automatically and continuously. If worded with a condition ("when~" / "if~"), they resolve automatically the moment the condition is met — **even if unfavorable to you.**

### Quick (クイック)

- Quick abilities and Quick Effect cards can be used **at any time.**
- Quick effects can **interrupt** other effects.
- When two players want to use Quick simultaneously, the **turn player** goes first.
- A Quick used in response to another effect **resolves first** (before the effect it responds to).
- **Cost is still paid from hand** — Quick changes _when_ you can act, not _how_ you pay. A Quick Effect card must still be Set then Opened; the Quick just frees the timing.

> Quick has the trickiest timing in the game. Beginners can treat Quick cards simply as "usable anytime" until comfortable.

---

## 14. Interrupts, Priority & Resolution

Cards/rules effects go into a **"pending resolution" (解決待機)** state before resolving.

- When an effect becomes pending, **priority (優先権)** passes — turn player first, then opponent.
- A player with priority may **(1) interrupt** with a Quick effect (which itself becomes pending on top) **or (2) pass.**
- When **both players pass consecutively**, the most recently pending effect resolves, then priority resets to the turn player.
- Multiple pending effects resolve in an order that depends on the sequence they were stacked — **track the order** (take notes if needed).
- **Interrupts cannot happen mid-resolution** of a single effect.

**Turn-player-priority rule:** when multiple conditional effects would trigger at once, they become pending in the order **turn player → non-turn player**, one at a time.

**Effects vs. rules:** if a card effect contradicts a rule, the **card effect takes precedence** (unless a rule specifically amends card effects).

**Controller:** the player who opened/used a card controls it and makes any choices its effects require. A cost-bearing ability may only be used by the controller while the card is on the field.

---

## 15. Key Terms (用語)

| Term                         | Meaning                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open (オープン)**          | Flip a Set Card face-up. If cost is paid, its effect goes pending. Can't pay (over Level, or Unique conflict) → it stays a Set Card, no cost paid. |
| **Set / Set Card**           | Place a card face-down in a city / a face-down card on the field. Only the controller may look at it.                                              |
| **Trash (トラッシュ)**       | Discard pile for used cards. All Trash cards are public.                                                                                           |
| **Distance (距離)**          | City-to-city distance. "Distance 1" = adjacent city; "Distance 1–2" = adjacent and one beyond.                                                     |
| **Target (標的)**            | Specify a subject within a defined range. Targets are chosen **when the effect goes pending**, not when it resolves.                               |
| **Occupied City (占領都市)** | A city currently occupied by either player.                                                                                                        |
| **Neutral City (中立都市)**  | A city occupied by no one.                                                                                                                         |
| **Field (場)**               | Everything in play except deck and Trash.                                                                                                          |
| **Search (探す)**            | Look through your deck for a card; you need not find/take one even if present.                                                                     |
| **Reduce (軽減)**            | Lower a damage value.                                                                                                                              |
| **Negate (無効)**            | Make a specified thing stop affecting the game.                                                                                                    |

---

## 16. Strategy Notes (derived from mechanics)

_There is no documented competitive scene for this game; the following reasons from the ruleset, not tournament results._

- **Tempo is the only path to victory** — occupation is the win condition and every game-deciding event happens in combat. Raw card advantage is throttled by the one-open-per-turn rule, so a fat hand converts to board too slowly to win on its own.
- **Mercenaries are the backbone** — exempt from the 3-copy cap, cheap under the Level gate, and the way you contest multiple cities and open multiple fronts in a turn.
- **Level curve matters like a mana curve** — top-heavy decks brick against City-Level gating. Run low-Level bodies to build cities up before your bombs.
- **Range = initiative** — higher Range deals damage first, functioning like first-strike. Prize efficient Range/Power/HP ratios.
- **Discard is a support tax, not a plan** — best used proactively to strip a specific answer/Quick right before an occupation push (defender-opens-first timing enables this). As a passive value engine it hollows out your board and folds to Quick and combat.
- **Hold Quick for the closing fight** — since occupation resolves in combat, the player holding Quick interaction during the deciding battle has the real leverage.
- **Don't overextend into one city** — attacking an occupied city forces the holder to commit everyone, so spreading pressure and timing the simultaneous 3-city push beats snowballing one location.
- **Multiple battles per turn are possible** — one per city, limited chiefly by having enough **unlocked** characters spread across the map.

---

_Reference compiled from the original Konami Berserk TCG Official Rulebook (18 pages), volumes BK1–BK5, 2003–2005._
