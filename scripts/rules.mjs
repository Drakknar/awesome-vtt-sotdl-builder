/**
 * Part of awesome-vtt-sotdl-builder: Shadow of the Demon Lord character creation rules, as plain functions over a
 * build plan and the ancestry / path documents it names.
 *
 * Rules followed (core book, "Ancestries", "Level Advancement", "Professions", "Starting Equipment", "Spells"):
 * - Characters start at level 0 (the GM may set 1, 3 or 7, or any level up to 10). Novice path at 1, expert at 3,
 *   master at 7; each level grants that path's (or the ancestry's, at 4) benefits.
 * - Starting scores come from the ancestry. Once, a score may go up by 1 if another goes down by 1.
 * - Ancestry level 4: "You either learn one spell or gain <talent>" (the ancestry's level-4 talent pick).
 * - Two professions; languages from the ancestry; wealth (3d6) decides lifestyle and starting equipment.
 * - Spells: a spell's rank must be equal to or lower than Power.
 * - Level up ("Level Advancement"): each new level grants its benefits; a new path at 1, 3 and 7.
 *
 * A plan creates a character (`fromLevel` −1) or levels one up from `fromLevel` to `level`: only the levels above
 * `fromLevel` count (their choices, gains, grants and talents; ancestry level 0 only for a new character), and the
 * ancestry and paths a levelled-up character already has are its embedded items.
 *
 * How the demonlord system stores these choices (so it applies them itself when the items are embedded):
 * - Ancestry level 0 adds `value − 10` to each attribute (the actor keeps 10s), so score adjustments are written into
 *   the embedded ancestry's level-0 values. Its level-0 size is overridden with the chosen size.
 * - Other levels add each attribute's value only when it is `selected` (or the level is "fixed"); path levels
 *   "choosetwo" / "choosethree" ask for two / three attributes.
 * - A level's `talents` and `languages` are always added; `talentspick` and `spells` entries only when `selected`.
 */

import { APPEARANCE, ATTRS, CHARACTERISTICS, COINS, TIERS } from "./constants.mjs";
import { languageNames, stripMarkup } from "./content.mjs";

/**
 * A new, empty build plan (a new character unless `fromLevel` ≥ 0).
 * @param {number} level
 * @param {number} fromLevel
 * @returns {object}
 */
export function newPlan(level = 0, fromLevel = -1) {
  return {
    version: 1,
    fromLevel,
    name: "",
    img: "",
    level,
    ancestry: {
      uuid: null, size: null, bonus: null, adjustUp: null, adjustDown: null, l4: null, l4Spell: null, choices: {}
    },
    paths: Object.fromEntries(TIERS.map(t => [t.id, { uuid: null, choices: {} }])),
    traditions: [],
    spells: [],
    professions: [],
    languages: [],
    equipment: { lifestyle: null, wealthRoll: null, items: [], coins: Object.fromEntries(COINS.map(c => [c, 0])) },
    bio: { religion: "", traits: [], interesting: "", appearance: Object.fromEntries(APPEARANCE.map(k => [k, ""])), notes: "" }
  };
}

/* -------------------------------------------- */
/*  Levels                                      */
/* -------------------------------------------- */

const levelNumber = level => Number(level?.level ?? 0) || 0;

/**
 * A level's key in the plan's choices ("0", "1", …).
 * @param {object} level
 * @returns {string}
 */
export const levelKey = level => String(levelNumber(level));

/**
 * The id the plan stores for a talent pick (`talentspick` entries carry a uuid, or only an id).
 * @param {object|undefined} pick
 * @returns {string|undefined}
 */
export const pickId = pick => pick?.uuid ?? pick?.id ?? pick?._id;

/**
 * An ancestry's or path's entry for one level.
 * @param {object|null} doc
 * @param {number} n
 * @returns {object|null}
 */
const levelAt = (doc, n) => (doc?.system?.levels ?? []).find(l => levelNumber(l) === n) ?? null;

/**
 * How many attributes a level asks the player to choose (0 for none or fixed).
 * @param {object|undefined} level
 * @returns {number}
 */
export function attrChoiceCount(level) {
  const select = level?.attributeSelect ?? "";
  if ( select === "choosetwo" || level?.attributeSelectIsChooseTwo ) return 2;
  if ( select === "choosethree" || level?.attributeSelectIsChooseThree ) return 3;
  return 0;
}

/**
 * Does a level raise every attribute by its value without a choice?
 * @param {object|undefined} level
 * @returns {boolean}
 */
const isFixed = level => (level?.attributeSelect === "fixed") || !!level?.attributeSelectIsFixed;

/**
 * Is a level one the plan gains (all of them for a new character, those above `fromLevel` for a level up)?
 * @param {object} plan
 * @param {object} level
 * @returns {boolean}
 */
export const isNewLevel = (plan, level) => levelNumber(level) > (plan.fromLevel ?? -1);

/**
 * Does the plan create the character (and so gain the ancestry's level 0: scores, size, languages, two professions)?
 * @param {object} plan
 * @returns {boolean}
 */
export const isNewCharacter = plan => isNewLevel(plan, { level: 0 });

/**
 * The levels of an ancestry or path the plan gains.
 * @param {object|null} doc
 * @param {object} plan
 * @returns {object[]}
 */
export const newLevels = (doc, plan) => levelsUpTo(doc, plan.level).filter(l => isNewLevel(plan, l));

/**
 * The levels of an ancestry or path that apply at a character level (level 0 of an ancestry included).
 * @param {object|null} doc
 * @param {number} characterLevel
 * @returns {object[]}
 */
export function levelsUpTo(doc, characterLevel) {
  return (doc?.system?.levels ?? []).filter(l => levelNumber(l) <= characterLevel);
}

/**
 * Paths tiers that apply at a character level (novice from 1, expert from 3, master from 7).
 * @param {number} characterLevel
 * @returns {object[]}
 */
export const tiersFor = characterLevel => TIERS.filter(t => characterLevel >= t.from);

/**
 * An ancestry's level-0 entry.
 * @param {object|null} doc
 * @returns {object|null}
 */
export const ancestryBase = doc => levelAt(doc, 0);

/**
 * The size choices of an ancestry's level 0 (Human: 1/2 or 1).
 * @param {object|null} doc
 * @returns {string[]}
 */
export function sizeOptions(doc) {
  const size = ancestryBase(doc)?.characteristics?.size;
  if ( Array.isArray(size) ) return size.map(String);
  return size ? [String(size)] : ["1"];
}

/**
 * Does the ancestry's level 0 let the player raise one attribute (an ancestry with a "choose" selection at level 0,
 * such as the core book's Human)? Fixed ancestries list their scores and get only the general adjustment.
 * @param {object|null} doc
 * @returns {boolean}
 */
export function hasAncestryBonus(doc) {
  const base = ancestryBase(doc);
  return !!base && !isFixed(base) && !!base.attributeSelect;
}

/**
 * The ancestry's level-4 talent pick ("you either learn one spell or gain <talent>"), or null.
 * @param {object|null} doc
 * @returns {object|null}
 */
export function ancestryL4(doc) {
  const level = levelAt(doc, 4);
  return level?.talentspick?.length ? level : null;
}

/**
 * Languages granted by the ancestry's level-0 text (names, matched to language items later).
 * @param {object|null} doc
 * @returns {string[]}
 */
export const ancestryLanguages = doc => languageNames(ancestryBase(doc)?.languagesText);

/* -------------------------------------------- */
/*  Scores and characteristics                  */
/* -------------------------------------------- */

const int = value => Number(value) || 0;

/**
 * Starting scores: the ancestry's level-0 values, the ancestry bonus and the one-time adjustment.
 * @param {object} plan
 * @param {object|null} ancestry
 * @returns {Record<string, number>}
 */
export function startingScores(plan, ancestry) {
  const base = ancestryBase(ancestry);
  const scores = Object.fromEntries(ATTRS.map(a => [a, int(base?.attributes?.[a]?.value) || 10]));
  const { bonus, adjustUp, adjustDown } = plan.ancestry;
  if ( bonus && hasAncestryBonus(ancestry) ) scores[bonus] += 1;
  if ( adjustUp && adjustDown && (adjustUp !== adjustDown) ) {
    scores[adjustUp] += 1;
    scores[adjustDown] -= 1;
  }
  return scores;
}

/**
 * Chosen attributes of a level (from the plan's choices for that source).
 * @param {object|undefined} choices
 * @param {object} level
 * @returns {string[]}
 */
const chosenAttrs = (choices, level) => choices?.[levelKey(level)]?.attrs ?? [];

/**
 * Every level the plan gains: `[{ source: "ancestry"|tier, doc, level, choices }]`. The ancestry's level 0 is left
 * out (its scores are the starting scores).
 * @param {object} plan
 * @param {object} docs
 * @returns {object[]}
 */
function appliedLevels(plan, docs) {
  const out = [];
  for ( const level of newLevels(docs.ancestry, plan) ) {
    if ( levelNumber(level) > 0 ) out.push({ source: "ancestry", doc: docs.ancestry, level, choices: plan.ancestry.choices });
  }
  for ( const tier of tiersFor(plan.level) ) {
    const doc = docs[tier.id];
    const choices = plan.paths[tier.id].choices;
    for ( const level of newLevels(doc, plan) ) out.push({ source: tier.id, doc, level, choices });
  }
  return out;
}

/**
 * What the gained levels add: `{ scores: {attr: n}, health, perception, defense, power, healingRate, speed }`.
 * @param {object} plan
 * @param {object} docs
 * @returns {object}
 */
export function levelGains(plan, docs) {
  const gains = {
    scores: Object.fromEntries(ATTRS.map(a => [a, 0])), ...Object.fromEntries(CHARACTERISTICS.map(k => [k, 0]))
  };
  for ( const { level, choices } of appliedLevels(plan, docs) ) {
    const picked = chosenAttrs(choices, level);
    for ( const a of ATTRS ) {
      if ( isFixed(level) || picked.includes(a) ) gains.scores[a] += int(level.attributes?.[a]?.value);
    }
    for ( const key of CHARACTERISTICS ) gains[key] += int(level.characteristics?.[key]);
  }
  return gains;
}

/**
 * The character's scores and characteristics as the system will derive them (before equipment): health is Strength
 * plus bonuses, Perception is Intellect plus bonuses, Defense is Agility plus bonuses (armor not counted), healing
 * rate a quarter of Health, Insanity limit equal to Will.
 * @param {object} plan
 * @param {object} docs
 * @returns {object}
 */
export function computeStats(plan, docs) {
  const start = startingScores(plan, docs.ancestry);
  const base = ancestryBase(docs.ancestry);
  const gains = levelGains(plan, docs);
  const bonus = Object.fromEntries(CHARACTERISTICS
    .map(k => [k, gains[k] + (k === "speed" ? 0 : int(base?.characteristics?.[k]))]));
  const scores = Object.fromEntries(ATTRS.map(a => [a, Math.clamp(start[a] + gains.scores[a], 0, 20)]));
  const health = scores.strength + bonus.health;
  const size = plan.ancestry.size ?? sizeOptions(docs.ancestry)[0];
  return withModifiers({
    scores,
    perception: Math.min(25, scores.intellect + bonus.perception),
    defense: scores.agility + bonus.defense,
    health,
    healingRate: Math.floor(health / 4) + bonus.healingRate,
    power: bonus.power,
    speed: (int(base?.characteristics?.speed) || 10) + bonus.speed,
    size,
    insanityMax: scores.will
  });
}

const withModifiers = stats => ({ ...stats, modifiers: Object.fromEntries(ATTRS.map(a => [a, stats.scores[a] - 10])) });

/**
 * A level up's preview: the actor's current derived values plus the gains (Health follows Strength, Perception
 * Intellect, Defense Agility, as the system derives them; armor that fixes Defense isn't considered).
 * @param {object} plan
 * @param {object} docs
 * @param {Actor} actor
 * @returns {object}
 */
export function levelUpStats(plan, docs, actor) {
  const sys = actor.system;
  const gains = levelGains(plan, docs);
  const scores = Object.fromEntries(ATTRS.map(a => {
    return [a, Math.clamp(int(sys.attributes[a]?.value) + gains.scores[a], 0, 20)];
  }));
  const raised = a => scores[a] - int(sys.attributes[a]?.value);
  const health = int(sys.characteristics.health.max) + gains.health + raised("strength");
  return withModifiers({
    scores,
    perception: Math.min(25, int(sys.attributes.perception?.value) + gains.perception + raised("intellect")),
    defense: int(sys.characteristics.defense) + gains.defense + raised("agility"),
    health,
    healingRate: Math.floor(health / 4) + gains.healingRate,
    power: int(sys.characteristics.power) + gains.power,
    speed: int(sys.characteristics.speed) + gains.speed,
    size: sys.characteristics.size,
    insanityMax: scores.will
  });
}

/* -------------------------------------------- */
/*  What is left to choose                      */
/* -------------------------------------------- */

/**
 * Does the plan gain the ancestry's level 4 (with its talent-or-spell choice)?
 * @param {object} plan
 * @param {object|null} ancestry
 * @returns {boolean}
 */
export const gainsL4 = (plan, ancestry) => (plan.level >= 4) && (plan.fromLevel < 4) && !!ancestryL4(ancestry);

/**
 * Is the ancestry's level-4 choice (talent, or a spell and which one) still open?
 * @param {object} plan
 * @param {object|null} ancestry
 * @returns {boolean}
 */
export function l4Missing(plan, ancestry) {
  if ( !gainsL4(plan, ancestry) ) return false;
  const { l4, l4Spell } = plan.ancestry;
  return !l4 || ((l4 === "spell") && !l4Spell);
}

/**
 * Choices of one level still missing: `{ attrs, pick }` counts.
 * @param {object} level
 * @param {object|undefined} choices
 * @returns {{attrs: number, pick: number}}
 */
export function levelMissing(level, choices) {
  const want = attrChoiceCount(level);
  const have = chosenAttrs(choices, level).length;
  const pickNeeded = (level?.talentspick?.length ?? 0) > 0;
  const pick = choices?.[levelKey(level)]?.pick;
  return { attrs: Math.max(0, want - have), pick: pickNeeded && !pick ? 1 : 0 };
}

/**
 * Remaining required choices per step: `{ ancestry, attributes, paths, magic, professions, background, equipment,
 * review }` (0 = done), with the build's `professionAllowance` and `magicAllowance`. Equipment never blocks (bought
 * gear has no rules limit).
 * @param {object} plan
 * @param {object} docs
 * @param {object} allowance
 * @param {object} magic
 * @returns {object}
 */
export function remaining(plan, docs, allowance, magic) {
  const out = {
    ancestry: 0, attributes: 0, paths: 0, magic: 0, professions: 0, background: 0, equipment: 0, review: 0
  };
  if ( isNewCharacter(plan) ) {
    const { uuid, size, bonus, adjustUp, adjustDown } = plan.ancestry;
    if ( !uuid || !docs.ancestry ) out.ancestry += 1;
    else {
      if ( sizeOptions(docs.ancestry).length > 1 && !size ) out.ancestry += 1;
      if ( hasAncestryBonus(docs.ancestry) && !bonus ) out.attributes += 1;
      if ( !adjustUp !== !adjustDown ) out.attributes += 1;
    }
    if ( !plan.name.trim() ) out.background += 1;
  }
  if ( l4Missing(plan, docs.ancestry) ) out.paths += 1;
  for ( const tier of tiersFor(plan.level) ) {
    const doc = docs[tier.id];
    if ( !plan.paths[tier.id].uuid || !doc ) { out.paths += 1; continue; }
    for ( const level of newLevels(doc, plan) ) {
      const miss = levelMissing(level, plan.paths[tier.id].choices);
      out.paths += miss.attrs + miss.pick;
    }
  }
  out.professions = allowance.missing + allowance.over;
  out.magic = magic.missing + magic.over;
  out.review = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

/**
 * Guidance texts of the applied levels (languages / professions / magic / options), for the player to follow.
 * @param {object} plan
 * @param {object} docs
 * @param {string} field
 * @returns {{source: string, level: number, text: string}[]}
 */
export function guidance(plan, docs, field) {
  const out = [];
  const base = ancestryBase(docs.ancestry);
  if ( isNewCharacter(plan) && base?.[field] ) out.push({ source: docs.ancestry.name, level: 0, text: base[field] });
  for ( const { doc, level } of appliedLevels(plan, docs) ) {
    if ( level?.[field] ) out.push({ source: doc.name, level: levelNumber(level), text: level[field] });
  }
  return out;
}

/* -------------------------------------------- */
/*  Professions and languages                   */
/* -------------------------------------------- */

/**
 * A text's sentences.
 * @param {string|undefined} text
 * @returns {string[]}
 */
const sentences = text => String(text ?? "").split(/(?<=\.)\s+/);

const PROFESSION_RE = /profession|area of knowledge|scholarship/;
const LANGUAGE_RE = /(speak|add) (another|one additional|an additional|one|a) language|additional language/;

/**
 * What one grant text gives, by sentence: `{ profession, language, either }`. The compendium states these grants
 * only as text; every text in the core book follows one of these forms:
 * - "add one … profession" / "add one academic area of knowledge" → a profession;
 * - "speak another language or add a … profession" → either one (the player chooses);
 * - "speak another language and add a … profession" → both;
 * - "read one language … or add a language" → a language.
 * @param {string} text
 * @returns {{profession: number, language: number, either: number}}
 */
function parseGrants(text = "") {
  const out = { profession: 0, language: 0, either: 0 };
  for ( const sentence of sentences(text.toLowerCase()) ) {
    const prof = PROFESSION_RE.test(sentence);
    const lang = LANGUAGE_RE.test(sentence);
    if ( prof && lang ) {
      if ( /\band add\b/.test(sentence) ) { out.profession += 1; out.language += 1; }
      else out.either += 1;
    }
    else if ( prof ) out.profession += 1;
    else if ( lang ) out.language += 1;
  }
  return out;
}

/**
 * Background results that teach a language ("You speak one additional language").
 * @param {object} plan
 * @returns {number}
 */
const traitLanguages = plan => plan.bio.traits.filter(t => /speak one additional language/i.test(t.text ?? "")).length;

/**
 * Languages the player added beyond the ancestry's own.
 * @param {object} plan
 * @param {object|null} ancestry
 * @returns {object[]}
 */
function extraLanguages(plan, ancestry) {
  const own = new Set(ancestryLanguages(ancestry).map(n => n.toLowerCase()));
  return plan.languages.filter(l => !l.auto && !own.has(l.name.toLowerCase()));
}

/**
 * How many professions and extra languages the build allows ("Professions": you begin with two professions and can
 * trade a profession to speak another language; ancestry and path levels up to the character's level add more):
 * - `maxProfessions`: 2 + profession grants + either-or grants (a level up counts only its new grants, without the 2);
 * - `budget`: professions and extra languages together, 2 + every grant (+ background results that teach a language);
 * - `maxLanguages`: extra languages, what the budget leaves after the chosen professions;
 * - `professions`, `languages`: used; `canAddProfession`, `canAddLanguage`; `over`: choices to remove.
 * @param {object} plan
 * @param {object} docs
 * @returns {object}
 */
export function professionAllowance(plan, docs) {
  const grants = { profession: 0, language: traitLanguages(plan), either: 0 };
  for ( const { text } of guidance(plan, docs, "languagesText") ) {
    const g = parseGrants(text);
    for ( const key of Object.keys(grants) ) grants[key] += g[key];
  }
  const start = isNewCharacter(plan) ? 2 : 0;
  const maxProfessions = start + grants.profession + grants.either;
  const budget = maxProfessions + grants.language;
  const professions = plan.professions.length;
  const languages = extraLanguages(plan, docs.ancestry).length;
  const used = professions + languages;
  return {
    grants, maxProfessions, budget, professions, languages, used,
    maxLanguages: Math.max(languages, budget - professions),
    canAddProfession: (professions < maxProfessions) && (used < budget),
    canAddLanguage: used < budget,
    over: Math.max(0, professions - maxProfessions, used - budget),
    missing: Math.max(0, start - used)
  };
}

/* -------------------------------------------- */
/*  Magic: traditions and spells                */
/* -------------------------------------------- */

const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
const countOf = word => COUNT_WORDS[word] ?? (Number(word) || 1);

/**
 * Tradition names a grant text restricts itself to ("the Theurgy tradition", "the Life, Nature, or Primal tradition").
 * @param {string} phrase
 * @returns {string[]|null}
 */
const namedTraditions = phrase => {
  const names = (phrase.match(/\b[A-Z][a-z]+\b/g) ?? []).filter(n => !["You", "The", "Then", "In"].includes(n));
  return names.length ? names : null;
};

/**
 * The magic grants of one text, per sentence: `[{ kind: "tradition"|"spell"|"choice", only: [names] | null }]`.
 * The compendium states them only as text; every text of the core book has one of these forms:
 * - "make two choices … discover a tradition or learn a spell" → that many choices;
 * - "discover <a | the X | the X, Y, or Z> tradition … or learn … spell" → one choice (restricted to the named ones);
 * - "discover one tradition" → a tradition; "learn one / two spells" → spells. "Learn the <name> spell" names a spell
 *   the level lists itself (Spellbinder 3's spellbound weapon); it is given with the level, not chosen.
 * A "For each choice, …" sentence only explains the choices before it.
 * "Associated with your religion" isn't restricted (the data doesn't tie traditions to religions).
 * @param {string|undefined} text
 * @returns {{kind: string, only: string[]|null}[]}
 */
export function parseMagic(text) {
  const grants = [];
  const add = (kind, n = 1, only = null) => { for ( let i = 0; i < n; i++ ) grants.push({ kind, only }); };
  for ( const sentence of sentences(stripMarkup(text)) ) {
    const lower = sentence.toLowerCase();
    // "For each choice, you either discover … or learn …" explains the choices of the sentence before it.
    if ( lower.startsWith("for each") ) continue;
    const choices = /make (\w+) choices/.exec(lower);
    const either = /discover (.*?) tradition\b.*\bor (?:you )?learn/.exec(sentence);
    const tradition = /discover (.*?) tradition\b/.exec(sentence);
    const spells = /learn (\w+) spells?\b/.exec(lower);
    if ( choices ) add("choice", countOf(choices[1]));
    else if ( either ) add("choice", 1, namedTraditions(either[1]));
    else if ( tradition ) add("tradition", 1, namedTraditions(tradition[1]));
    // "You learn the <name> spell": a spell the level itself lists, given with the level (not a choice).
    else if ( /learn the .+? spell\b/.test(lower) ) continue;
    else if ( spells ) add("spell", countOf(spells[1]));
  }
  return grants;
}

/**
 * Can a grant take this tradition or spell? (An item without tradition stands for "any".)
 * @param {object} grant
 * @param {object} item
 * @returns {boolean}
 */
const fits = (grant, item) => ((grant.kind === "choice") || (grant.kind === item.kind))
  && (!grant.only || !item.tradition || grant.only.includes(item.tradition));

/**
 * How many of the items can each take a grant of their own (bipartite matching; the lists are short).
 * @param {object[]} grants
 * @param {object[]} items
 * @returns {number}
 */
function matched(grants, items) {
  const owner = new Array(grants.length).fill(-1);
  const assign = (i, seen) => grants.some((g, j) => {
    if ( seen.has(j) || !fits(g, items[i]) ) return false;
    seen.add(j);
    if ( (owner[j] === -1) || assign(owner[j], seen) ) {
      owner[j] = i;
      return true;
    }
    return false;
  });
  return items.reduce((n, _, i) => n + (assign(i, new Set()) ? 1 : 0), 0);
}

/**
 * Traditions and spells the build may take ("Magic": discovering a tradition teaches one of its rank 0 spells; other
 * spells come from traditions you have discovered and have a rank no higher than your Power), from the gained levels'
 * magic texts. `known`: traditions the character already has (a level up); `spellInfo(uuid)` → `{ tradition, rank }`.
 * Returns the grants, the counts used, which traditions / spells can still be added, and what is missing or over.
 * @param {object} plan
 * @param {object} docs
 * @param {object} root0
 * @param {number} root0.power
 * @param {string[]} root0.known
 * @param {(uuid: string) => object|null} root0.spellInfo
 * @returns {object}
 */
export function magicAllowance(plan, docs, { power = 0, known = [], spellInfo = () => null } = {}) {
  const grants = guidance(plan, docs, "magicText").flatMap(g => parseMagic(g.text));
  const traditions = plan.traditions.map(t => ({ kind: "tradition", tradition: t.name }));
  const spells = plan.spells.map(uuid => ({ kind: "spell", uuid, ...(spellInfo(uuid) ?? {}) }));
  const items = [...traditions, ...spells];
  const used = matched(grants, items);
  const discovered = new Set([...known, ...plan.traditions.map(t => t.name)]);
  const learnable = info => !!info && discovered.has(info.tradition) && (info.rank <= power);
  // Whether one more item fits only depends on its kind and tradition: cached per render.
  const takes = new Map();
  const canTake = (kind, tradition) => {
    const key = `${kind}|${tradition}`;
    if ( !takes.has(key) ) takes.set(key, matched(grants, [...items, { kind, tradition }]) === used + 1);
    return takes.get(key);
  };
  // How many more of a kind could still be taken (no tradition restriction), for "X of N": extending the current
  // matching with as many as there are grants takes exactly that many more.
  const room = kind => matched(grants, [...items, ...Array.from(grants, () => ({ kind }))]) - used;
  const invalidSpells = spells.filter(s => !learnable(s)).length;
  // The free spell of a discovery: missing, or not a rank 0 spell of that tradition.
  const freeMissing = plan.traditions.filter(t => !t.spell).length;
  const freeInvalid = plan.traditions.filter(t => {
    const spell = t.spell && spellInfo(t.spell);
    return t.spell && ((spell?.tradition !== t.name) || (spell.rank !== 0));
  }).length;
  const l4Invalid = (plan.ancestry.l4 === "spell") && plan.ancestry.l4Spell && !learnable(spellInfo(plan.ancestry.l4Spell)) ? 1 : 0;
  return {
    grants: grants.length,
    traditions: traditions.length,
    spells: spells.length,
    maxTraditions: traditions.length + room("tradition"),
    maxSpells: spells.length + room("spell"),
    discovered: [...discovered].sort(),
    canAddTradition: name => !discovered.has(name) && canTake("tradition", name),
    /** May the character learn this spell at all (discovered tradition, rank ≤ Power)? Also the level-4 spell. */
    learnable,
    canAddSpell: info => learnable(info) && canTake("spell", info.tradition),
    // Choices to remove: unmatched or not allowed (a spell can be both; it's one removal).
    over: Math.max(items.length - used, invalidSpells) + freeInvalid + l4Invalid,
    missing: (grants.length - used) + freeMissing
  };
}

/**
 * Keep only the choices that still make sense after the level, ancestry or a path changed.
 * @param {object} plan
 * @param {object} docs
 */
export function pruneChoices(plan, docs) {
  const keep = (doc, choices) => {
    const valid = new Set(newLevels(doc, plan).map(levelKey));
    for ( const key of Object.keys(choices) ) if ( !valid.has(key) ) delete choices[key];
  };
  keep(docs.ancestry, plan.ancestry.choices);
  if ( !gainsL4(plan, docs.ancestry) ) plan.ancestry.l4 = null;
  if ( plan.ancestry.l4 !== "spell" ) plan.ancestry.l4Spell = null;
  for ( const tier of TIERS ) {
    if ( plan.level < tier.from ) plan.paths[tier.id] = { uuid: null, choices: {} };
    else keep(docs[tier.id], plan.paths[tier.id].choices);
  }
}

/* -------------------------------------------- */
/*  What the character ends up with             */
/* -------------------------------------------- */

/**
 * Every spell uuid the plan learns (the Magic step's and the ancestry's level-4 spell).
 * @param {object} plan
 * @returns {string[]}
 */
export function allSpells(plan) {
  const l4 = (plan.ancestry.l4 === "spell") && plan.ancestry.l4Spell;
  const free = plan.traditions.map(t => t.spell).filter(Boolean);
  return [...new Set([...free, ...plan.spells, ...(l4 ? [l4] : [])])];
}

/**
 * Every language the character speaks: the ancestry's, then the plan's (case-insensitive, the plan's entry wins for
 * read / write). `[{ uuid, name, read, write }]`.
 * @param {object} plan
 * @param {object|null} ancestry
 * @returns {object[]}
 */
export function allLanguages(plan, ancestry) {
  const out = new Map();
  for ( const name of ancestryLanguages(ancestry) ) {
    out.set(name.toLowerCase(), { uuid: null, name, read: false, write: false });
  }
  for ( const lang of plan.languages ) out.set(lang.name.toLowerCase(), lang);
  return [...out.values()];
}

/**
 * The talents the character gains (fixed ones and picks), with their source: `[{ name, uuid, source }]`.
 * @param {object} plan
 * @param {object} docs
 * @returns {{name: string, uuid: string, source: string}[]}
 */
export function chosenTalents(plan, docs) {
  const out = [];
  const add = (doc, list) => list.forEach(t => out.push({ name: t.name, uuid: t.uuid, source: doc.name }));
  if ( docs.ancestry && isNewCharacter(plan) ) add(docs.ancestry, ancestryBase(docs.ancestry)?.talents ?? []);
  for ( const { doc, level, choices } of appliedLevels(plan, docs) ) {
    add(doc, level.talents ?? []);
    if ( (doc === docs.ancestry) && (levelNumber(level) === 4) ) {
      if ( plan.ancestry.l4 === "talent" ) add(doc, (level.talentspick ?? []).slice(0, 1));
      continue;
    }
    const pick = choices?.[levelKey(level)]?.pick;
    add(doc, (level.talentspick ?? []).filter(t => pick && (pickId(t) === pick)));
  }
  return out;
}

/* -------------------------------------------- */
/*  A character's own items (level up)          */
/* -------------------------------------------- */

/**
 * The ancestry and the path of each tier an actor has: `{ ancestry, novice, expert, master }` (items or null).
 * @param {Actor} actor
 * @returns {object}
 */
export function ownedBuild(actor) {
  const find = test => actor.items.find(test) ?? null;
  return {
    ancestry: find(i => i.type === "ancestry"),
    ...Object.fromEntries(TIERS.map(t => [t.id, find(i => (i.type === "path") && (i.system.type === t.id))]))
  };
}

/**
 * Lowercased names of an actor's items of a type (none without an actor).
 * @param {Actor|null} actor
 * @param {string} type
 * @returns {Set<string>}
 */
export const ownedNames = (actor, type) =>
  new Set((actor?.items ?? []).filter(i => i.type === type).map(i => i.name.toLowerCase()));

/**
 * Traditions a character already has: those of its spells.
 * @param {Actor|null} actor
 * @returns {string[]}
 */
export const knownTraditions = actor => [...new Set((actor?.items ?? []).filter(i => i.type === "spell")
  .map(i => i.system.tradition).filter(Boolean))];
