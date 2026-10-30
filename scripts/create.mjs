/**
 * Part of awesome-vtt-sotdl-builder: turning a build plan into a demonlord character.
 *
 * The plan holds only uuids and choices. Whoever creates the actor (the player, or the active GM for players without
 * the "Create new actors" permission) loads the items from those uuids and applies the choices to the embedded copies,
 * so the demonlord system's own handlers add the talents and effects when the items are embedded:
 * the actor is created first (with its level), then all items in one createEmbeddedDocuments call.
 *
 * Plans that arrive over the socket are untrusted: `sanitizePlan` keeps only known fields with bounded sizes, and
 * every uuid must resolve to an Item of an allowed type that the requesting user can see.
 */

import { ALLOWED_TYPES, APPEARANCE, ATTRS, CHANNEL, COINS, EQUIPMENT_TYPES, LIMITS, LIFESTYLES, MODULE_ID,
  TIERS } from "./constants.mjs";
import { allLanguages, allSpells, ancestryBase, ancestryL4, attrChoiceCount, computeStats, gainsL4, knownTraditions,
  levelKey, levelUpStats, magicAllowance, newLevels, ownedBuild, ownedNames, pickId, professionAllowance, sizeOptions,
  startingScores, tiersFor } from "./rules.mjs";
import { contentIndex, findByName } from "./content.mjs";

const loc = key => game.i18n.localize(key);

/* -------------------------------------------- */
/*  Plan validation                             */
/* -------------------------------------------- */

const UUID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const str = (value, max = LIMITS.text) => (typeof value === "string" ? value.slice(0, max) : "");
const uuid = value => ((typeof value === "string") && UUID_RE.test(value) ? value : null);
const attr = value => (ATTRS.includes(value) ? value : null);
const count = (value, max = LIMITS.coins) => Math.clamp(Math.floor(Number(value) || 0), 0, max);
const list = (value, map, max = LIMITS.list) =>
  (Array.isArray(value) ? value.slice(0, max).map(map).filter(v => v != null) : []);

/** The same limits for the builder's form fields. */
export { str as cleanText, count as cleanCount };

/**
 * A copy of a level-choices map with only valid level keys, attributes and uuids.
 * @param {unknown} choices
 * @returns {object}
 */
function sanitizeChoices(choices) {
  const out = {};
  if ( !choices || (typeof choices !== "object") ) return out;
  for ( const [key, value] of Object.entries(choices).slice(0, 12) ) {
    if ( !/^\d{1,2}$/.test(key) ) continue;
    out[key] = { attrs: [...new Set(list(value?.attrs, attr, 4))], pick: uuid(value?.pick) };
  }
  return out;
}

/**
 * A copy of a plan with only known fields, bounded sizes and valid values (as a new-character plan).
 * @param {unknown} raw
 * @returns {object}
 */
export function sanitizePlan(raw) {
  const p = raw ?? {};
  const a = p.ancestry ?? {};
  return {
    version: 1,
    // Plans sent to the GM always create; a level up is applied by the actor's owner (`levelUpCharacter`).
    fromLevel: -1,
    name: str(p.name, LIMITS.name).trim(),
    img: str(p.img, 500),
    level: Math.clamp(Math.floor(Number(p.level) || 0), 0, LIMITS.level),
    ancestry: {
      uuid: uuid(a.uuid), size: str(a.size, 8) || null, bonus: attr(a.bonus), adjustUp: attr(a.adjustUp),
      adjustDown: attr(a.adjustDown), l4: ["talent", "spell"].includes(a.l4) ? a.l4 : null, l4Spell: uuid(a.l4Spell),
      choices: sanitizeChoices(a.choices)
    },
    paths: Object.fromEntries(TIERS.map(t => {
      const path = p.paths?.[t.id] ?? {};
      return [t.id, { uuid: uuid(path.uuid), choices: sanitizeChoices(path.choices) }];
    })),
    traditions: list(p.traditions, t => {
      const name = str(t?.name, 40).trim();
      return name ? { name, spell: uuid(t?.spell) } : null;
    }, 20),
    spells: [...new Set(list(p.spells, uuid))],
    professions: list(p.professions, e => {
      const name = str(e?.name, LIMITS.name).trim();
      return name ? { uuid: uuid(e?.uuid), name, text: str(e?.text) } : null;
    }),
    languages: list(p.languages, e => {
      const name = str(e?.name, LIMITS.name).trim();
      return name ? { uuid: uuid(e?.uuid), name, read: !!e?.read, write: !!e?.write, auto: !!e?.auto } : null;
    }),
    equipment: {
      lifestyle: LIFESTYLES.includes(p.equipment?.lifestyle) ? p.equipment.lifestyle : null,
      wealthRoll: p.equipment?.wealthRoll == null ? null : count(p.equipment.wealthRoll, 18),
      items: list(p.equipment?.items, e => {
        const id = uuid(e?.uuid);
        if ( !id ) return null;
        const qty = Math.max(1, count(e?.qty, 999));
        return { uuid: id, name: str(e?.name, LIMITS.name), img: str(e?.img, 500), qty };
      }, LIMITS.items),
      coins: Object.fromEntries(COINS.map(c => [c, count(p.equipment?.coins?.[c])]))
    },
    bio: {
      religion: str(p.bio?.religion, 500),
      traits: list(p.bio?.traits, t => (t?.label ? { label: str(t.label, 80), text: str(t.text, 1000) } : null), 20),
      interesting: str(p.bio?.interesting, 1000),
      appearance: Object.fromEntries(APPEARANCE.map(k => [k, str(p.bio?.appearance?.[k], 200)])),
      notes: str(p.bio?.notes)
    }
  };
}

/* -------------------------------------------- */
/*  Building the actor                          */
/* -------------------------------------------- */

/**
 * Load an Item the user may use: it must exist, be one of the allowed types (and `type` if given), and be visible to
 * `user` (an observable compendium, or a world item the user can at least see).
 * @param {string|null} id
 * @param {User} user
 * @param {string|string[]|undefined} type
 * @returns {Promise<Item|null>}
 */
async function loadItem(id, user, type) {
  if ( !id ) return null;
  const doc = await fromUuid(id).catch(() => null);
  if ( !(doc instanceof Item) || !ALLOWED_TYPES.has(doc.type) ) return null;
  if ( type && ![type].flat().includes(doc.type) ) return null;
  if ( doc.parent ) return null;
  const visible = doc.pack ? game.packs.get(doc.pack)?.testUserPermission(user, "OBSERVER")
    : doc.testUserPermission(user, "LIMITED");
  return visible ? doc : null;
}

/**
 * Item data ready to embed: a copy of the source without id, folder, sort or ownership.
 * @param {Item} doc
 * @returns {object}
 */
function itemData(doc) {
  const data = doc.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  if ( doc.pack ) foundry.utils.setProperty(data, "_stats.compendiumSource", doc.uuid);
  return data;
}

/**
 * The plan's attribute and pick choices written into the levels the plan gains of an ancestry's or path's data (the
 * system reads them there); levels the character already has are left as they are. Returns the levels written.
 * @param {object} data
 * @param {object} plan
 * @param {object} choices
 * @returns {object[]}
 */
function applyLevelChoices(data, plan, choices) {
  const levels = newLevels(data, plan);
  for ( const level of levels ) {
    const choice = choices[levelKey(level)] ?? {};
    if ( attrChoiceCount(level) ) {
      for ( const a of ATTRS ) {
        if ( level.attributes?.[a] ) level.attributes[a].selected = (choice.attrs ?? []).includes(a);
      }
    }
    for ( const pick of level.talentspick ?? [] ) pick.selected = !!choice.pick && (pickId(pick) === choice.pick);
    // Spells a level lists ("you learn the spellbound weapon spell") come with it.
    for ( const spell of level.spells ?? [] ) spell.selected = true;
  }
  return levels;
}

/**
 * The embedded ancestry: starting scores, size, and the level-4 talent when chosen.
 * @param {Item} doc
 * @param {object} plan
 * @returns {object}
 */
function ancestryItem(doc, plan) {
  const data = itemData(doc);
  const base = ancestryBase(data);
  if ( base ) {
    const scores = startingScores(plan, doc);
    for ( const a of ATTRS ) if ( base.attributes?.[a] ) base.attributes[a].value = Math.clamp(scores[a], 1, 20);
    const sizes = sizeOptions(doc);
    base.characteristics.size = sizes.includes(plan.ancestry.size) ? plan.ancestry.size : sizes[0];
  }
  applyLevelChoices(data, plan, plan.ancestry.choices);
  applyL4Choice(data, plan);
  return data;
}

/**
 * The ancestry's level-4 talent selected when the plan gains level 4 and chose the talent.
 * @param {object} data
 * @param {object} plan
 */
function applyL4Choice(data, plan) {
  if ( !gainsL4(plan, data) ) return;
  ancestryL4(data).talentspick.forEach((pick, i) => pick.selected = (plan.ancestry.l4 === "talent") && (i === 0));
}

/**
 * The plan's spells, professions, the given languages and equipment as item data, loaded in parallel; items keep the
 * plan's order.
 * @param {object} plan
 * @param {User} user
 * @param {object[]} languages
 * @returns {Promise<object[]>}
 */
async function plainItems(plan, user, languages) {
  const spells = Promise.all(allSpells(plan).map(async id => {
    const spell = await loadItem(id, user, "spell");
    return spell ? [itemData(spell)] : [];
  }));
  const professions = Promise.all(plan.professions.map(async profession => {
    const doc = await loadItem(profession.uuid, user, "profession");
    return [doc ? itemData(doc) : { name: profession.name, type: "profession", system: { description: paragraphs([profession.text]) } }];
  }));
  const langs = Promise.all(languages.map(async lang => {
    const doc = await loadItem(lang.uuid ?? (await findByName("language", lang.name))?.uuid, user, "language");
    const data = doc ? itemData(doc) : { name: lang.name, type: "language", system: {} };
    return [foundry.utils.mergeObject(data, { system: { speak: true, read: !!lang.read, write: !!lang.write } })];
  }));
  const equipment = Promise.all(plan.equipment.items.map(async entry => {
    const doc = await loadItem(entry.uuid, user, EQUIPMENT_TYPES);
    if ( !doc ) return [];
    const data = itemData(doc);
    if ( entry.qty === 1 ) return [data];
    if ( foundry.utils.hasProperty(data, "system.quantity") ) {
      data.system.quantity = entry.qty;
      return [data];
    }
    return Array.from({ length: entry.qty }, () => itemData(doc));
  }));
  return (await Promise.all([spells, professions, langs, equipment])).flat(2);
}

/**
 * Professions, languages, traditions and spells may not exceed what the gained levels allow (checked again here, so
 * the GM's side enforces it too): throws with a localized message.
 * @param {object} plan
 * @param {object} docs
 * @param {object} root0
 * @param {number} root0.power
 * @param {string[]} root0.known
 */
async function checkAllowances(plan, docs, { power, known = [] }) {
  if ( professionAllowance(plan, docs).over ) throw new Error(loc("AVTTSB.Create.Error.TooMany"));
  const index = await contentIndex();
  const magic = magicAllowance(plan, docs, { power, known, spellInfo: uuid => index.byUuid.get(uuid) });
  // Every discovered tradition needs its free rank 0 spell.
  if ( magic.over || plan.traditions.some(t => !t.spell) ) throw new Error(loc("AVTTSB.Create.Error.TooMuchMagic"));
}

/**
 * A path the plan names for a tier, loaded for `user` and with the plan's choices applied. Throws when missing.
 * @param {object} plan
 * @param {object} tier
 * @param {User} user
 * @returns {Promise<{doc: Item, data: object}>}
 */
async function pathItem(plan, tier, user) {
  const doc = await loadItem(plan.paths[tier.id].uuid, user, "path");
  if ( !doc ) throw new Error(game.i18n.format("AVTTSB.Create.Error.Path", { tier: loc(`AVTTSB.Tier.${tier.id}`) }));
  const data = itemData(doc);
  applyLevelChoices(data, plan, plan.paths[tier.id].choices);
  return { doc, data };
}

/**
 * A plain-text paragraph list for the biography.
 * @param {string[]} lines
 * @returns {string}
 */
const paragraphs = lines => lines.filter(Boolean).map(l => `<p>${foundry.utils.escapeHTML(l)}</p>`).join("");

/**
 * The actor data and the items to embed for a plan, built with what `user` may use. Throws with a localized message
 * when a required document is missing.
 * @param {unknown} raw
 * @param {User} user
 * @returns {Promise<{actor: object, items: object[]}>}
 */
export async function buildCharacter(raw, user = game.user) {
  const plan = sanitizePlan(raw);
  if ( !plan.name ) throw new Error(loc("AVTTSB.Create.Error.Name"));
  const ancestry = await loadItem(plan.ancestry.uuid, user, "ancestry");
  if ( !ancestry ) throw new Error(loc("AVTTSB.Create.Error.Ancestry"));
  const items = [ancestryItem(ancestry, plan)];
  const docs = { ancestry };

  for ( const tier of tiersFor(plan.level) ) {
    const { doc, data } = await pathItem(plan, tier, user);
    docs[tier.id] = doc;
    items.push(data);
  }

  await checkAllowances(plan, docs, { power: computeStats(plan, docs).power });

  items.push(...await plainItems(plan, user, allLanguages(plan, ancestry)));

  const traits = plan.bio.traits.map(t => `${t.label}: ${t.text}`);
  if ( plan.bio.interesting ) traits.push(`${loc("AVTTSB.Background.Interesting")}: ${plan.bio.interesting}`);
  const description = paragraphs([...traits, ...plan.bio.notes.split(/\n+/)]);

  const img = plan.img || undefined;
  const actor = {
    name: plan.name,
    type: "character",
    img,
    system: {
      level: plan.level,
      description,
      religion: { value: plan.bio.religion },
      appearance: plan.bio.appearance,
      wealth: { lifestyle: plan.equipment.lifestyle ?? "", ...plan.equipment.coins }
    },
    prototypeToken: { name: plan.name, actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
      ...(img ? { texture: { src: img } } : {}) },
    flags: { [MODULE_ID]: { plan } }
  };
  return { actor, items };
}

/**
 * Create the character for `user` (the current user unless the GM creates it for someone).
 * @param {unknown} raw
 * @param {User} user
 * @returns {Promise<Actor>}
 */
async function createFor(raw, user) {
  const { actor: actorData, items } = await buildCharacter(raw, user);
  const { NONE, OWNER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  actorData.ownership = { default: NONE, [user.id]: OWNER };
  const actor = await Actor.implementation.create(actorData);
  if ( !actor ) throw new Error(loc("AVTTSB.Create.Error.Failed"));
  // One call, so the system's create handler adds ancestry and path talents and effects in order.
  await actor.createEmbeddedDocuments("Item", items);
  if ( !user.isGM && !user.character && game.settings.get(MODULE_ID, "assignCharacter") ) {
    await user.update({ character: actor.id }).catch(() => null);
  }
  return actor;
}

/* -------------------------------------------- */
/*  Levelling up                                */
/* -------------------------------------------- */

/**
 * Item data for what one gained level of an embedded ancestry or path grants, as the system's own level change does
 * (`createActorNestedItems`): its talents and languages, and its selected talent picks and spells, flagged with their
 * parent and level so the system can remove them if the level goes down again.
 * @param {object} level
 * @param {string} parentId
 * @returns {Promise<object[]>}
 */
function nestedItems(level, parentId) {
  const entries = [...(level.talents ?? []), ...(level.languages ?? []),
    ...[...(level.talentspick ?? []), ...(level.spells ?? [])].filter(e => e.selected)];
  return Promise.all(entries.map(async entry => {
    const doc = entry.uuid ? await fromUuid(entry.uuid).catch(() => null) : null;
    const data = (doc instanceof Item) ? itemData(doc)
      : { name: entry.name, type: entry.data?.type ?? "talent", img: entry.img, system: entry.data?.system ?? entry.system ?? {} };
    foundry.utils.setProperty(data, "flags.demonlord", {
      nestedItemId: entry._id ?? entry.id, parentItemId: parentId, levelRequired: Number(level.level) || 0
    });
    return data;
  }));
}

/**
 * Raise a character's level with the plan's choices. In the order the system's own sheet works: the new levels'
 * choices are written into the ancestry and paths the character has, their talents added, then the level raised; a
 * new path is embedded after that, so the system adds its levels up to the new level itself. Spells, professions and
 * extra languages are added as plain items.
 * @param {Actor} actor
 * @param {unknown} raw
 * @returns {Promise<Actor>}
 */
export async function levelUpCharacter(actor, raw) {
  if ( !actor?.isOwner || (actor.type !== "character") ) throw new Error(loc("AVTTSB.LevelUp.Error.NotOwner"));
  const plan = { ...sanitizePlan(raw), fromLevel: Number(actor.system.level) || 0 };
  if ( plan.level <= plan.fromLevel ) throw new Error(loc("AVTTSB.LevelUp.Error.Level"));
  const docs = ownedBuild(actor);
  const owned = [{ item: docs.ancestry, choices: plan.ancestry.choices }];
  const added = [];
  for ( const tier of tiersFor(plan.level) ) {
    if ( docs[tier.id] ) owned.push({ item: docs[tier.id], choices: plan.paths[tier.id].choices });
    else {
      const { doc, data } = await pathItem(plan, tier, game.user);
      docs[tier.id] = doc;
      added.push(data);
    }
  }
  await checkAllowances(plan, docs, { power: levelUpStats(plan, docs, actor).power, known: knownTraditions(actor) });

  const updates = [];
  const nested = [];
  for ( const { item, choices } of owned ) {
    if ( !item ) continue;
    const data = item.toObject();
    const levels = applyLevelChoices(data, plan, choices);
    if ( !levels.length ) continue;
    if ( item === docs.ancestry ) applyL4Choice(data, plan);
    updates.push({ _id: item.id, "system.levels": data.system.levels });
    nested.push(...levels.map(level => nestedItems(level, item.id)));
  }
  const nestedData = (await Promise.all(nested)).flat();
  if ( updates.length ) await actor.updateEmbeddedDocuments("Item", updates);
  if ( nestedData.length ) await actor.createEmbeddedDocuments("Item", nestedData);
  await actor.update({ "system.level": plan.level });

  // Languages and spells the character already has aren't added twice.
  const languageNames = ownedNames(actor, "language");
  const spellNames = ownedNames(actor, "spell");
  const languages = plan.languages.filter(l => !languageNames.has(l.name.toLowerCase()));
  const extra = (await plainItems(plan, game.user, languages)).filter(d => (d.type !== "spell") || !spellNames.has(d.name.toLowerCase()));
  if ( added.length || extra.length ) await actor.createEmbeddedDocuments("Item", [...added, ...extra]);
  return actor;
}

/* -------------------------------------------- */
/*  Creating, directly or through the GM        */
/* -------------------------------------------- */

const pending = new Map();
const TIMEOUT = 120_000;

/**
 * Create the character from a plan. Players without the "Create new actors" permission ask the active GM, whose
 * client checks the plan and creates it with the player as owner.
 * @param {object} plan
 * @returns {Promise<Actor>}
 */
export async function createCharacter(plan) {
  if ( game.user.can("ACTOR_CREATE") ) return createFor(plan, game.user);
  if ( !game.users.activeGM ) throw new Error(loc("AVTTSB.Create.Error.NoGM"));
  const requestId = foundry.utils.randomID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(loc("AVTTSB.Create.Error.Timeout")));
    }, TIMEOUT);
    pending.set(requestId, { resolve, reject, timer });
  });
  game.socket.emit(CHANNEL, { type: "create", requestId, plan: sanitizePlan(plan) });
  const actorId = await result;
  return game.actors.get(actorId) ?? null;
}

/** Socket handling: the active GM creates for players; the requesting player gets the answer. */
export function registerSocket() {
  game.socket.on(CHANNEL, async (data, senderId) => {
    if ( (data?.type === "created") && (data.userId === game.user.id) ) {
      const entry = pending.get(data.requestId);
      if ( !entry ) return;
      clearTimeout(entry.timer);
      pending.delete(data.requestId);
      if ( data.error ) entry.reject(new Error(String(data.error).slice(0, 300)));
      else entry.resolve(String(data.actorId ?? ""));
      return;
    }
    if ( (data?.type !== "create") || !game.users.activeGM?.isSelf ) return;
    const user = game.users.get(senderId);
    const requestId = typeof data.requestId === "string" ? data.requestId.slice(0, 32) : "";
    if ( !user || user.isGM || !requestId ) return;
    const reply = payload => game.socket.emit(CHANNEL, { type: "created", requestId, userId: user.id, ...payload });
    if ( !game.settings.get(MODULE_ID, "playersMayCreate") ) return reply({ error: loc("AVTTSB.Create.Error.NotAllowed") });
    try {
      const actor = await createFor(data.plan, user);
      reply({ actorId: actor.id });
      ui.notifications.info(game.i18n.format("AVTTSB.Create.CreatedFor", { name: actor.name, user: user.name }));
    } catch ( err ) {
      console.error(`${MODULE_ID} | Creating a character for ${user.name} failed`, err);
      reply({ error: err.message });
    }
  });
}
