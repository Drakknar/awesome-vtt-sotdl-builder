/**
 * Part of awesome-vtt-sotdl-builder: finding the game content the builder offers.
 *
 * The demonlord system ships no ancestries, paths, talents or spells (only weapons, armor, ammunition and languages);
 * that content comes from compendium modules the group owns (for the core book, "sdlc-1000") or from world items.
 * Everything here is read from whatever Item compendiums and world items the user can see, never bundled.
 */

import { EQUIPMENT_TYPES, LIFESTYLES, MODULE_ID } from "./constants.mjs";

const INDEX_FIELDS = ["type", "system.type", "system.tradition", "system.rank"];
const OFFERED_TYPES = ["ancestry", "path", "profession", "spell", "language", ...EQUIPMENT_TYPES];

/** Session caches, dropped by `clearContent` (world items changed). The rulebook journal is never cached. */
let indexPromise = null;
const docs = new Map();
const tables = new Map();
const texts = new Map();
const linkNames = new Map();
let equipmentKits = null;

/** Forget cached indexes and documents. */
export function clearContent() {
  indexPromise = null;
  equipmentKits = null;
  for ( const cache of [docs, tables, texts, linkNames] ) cache.clear();
}

/**
 * Every offered item the user can see: one name-sorted list per type (`index.ancestry`, `index.path`, …) of
 * `{ uuid, name, img, type, pathType, tradition, rank, source, search }`, plus `index.equipment` (all equipment
 * types, sorted) and `index.byUuid` (a Map).
 * @returns {Promise<object>}
 */
export function contentIndex() {
  indexPromise ??= buildIndex().catch(err => {
    indexPromise = null;
    throw err;
  });
  return indexPromise;
}

/**
 * Read every visible Item compendium (creature gear left out) and the world's items into the index (see contentIndex).
 * @returns {Promise<object>}
 */
async function buildIndex() {
  // Creature-only weapons aren't starting gear.
  const packs = game.packs.filter(p => (p.documentName === "Item") && p.visible && !/creature/i.test(p.collection));
  const indexes = await Promise.all(packs.map(p => p.getIndex({ fields: INDEX_FIELDS })));
  const sources = packs.map((pack, i) => ({ title: pack.title, entries: indexes[i] }));
  sources.push({ title: game.i18n.localize("AVTTSB.WorldItems"), entries: game.items.filter(i => i.visible) });

  const index = Object.fromEntries(OFFERED_TYPES.map(t => [t, []]));
  for ( const { title, entries } of sources ) {
    for ( const e of entries ) {
      if ( !index[e.type] ) continue;
      index[e.type].push({
        uuid: e.uuid, name: e.name, img: e.img, type: e.type, source: title,
        pathType: e.type === "path" ? (e.system?.type ?? "") : "",
        tradition: e.system?.tradition ?? "",
        rank: Number(e.system?.rank) || 0,
        search: `${e.name} ${e.system?.tradition ?? ""} ${e.type}`.toLowerCase()
      });
    }
  }
  const { compare } = new Intl.Collator(game.i18n.lang);
  const byName = (a, b) => compare(a.name, b.name);
  for ( const type of OFFERED_TYPES ) index[type].sort(byName);
  index.equipment = EQUIPMENT_TYPES.flatMap(t => index[t]).sort(byName);
  index.byUuid = new Map(OFFERED_TYPES.flatMap(t => index[t]).map(e => [e.uuid, e]));
  return index;
}

/**
 * A document by uuid, loaded once (ancestries, paths, tables).
 * @param {string|null|undefined} uuid
 * @returns {Promise<Document|null>}
 */
export function getDoc(uuid) {
  if ( !uuid ) return Promise.resolve(null);
  if ( !docs.has(uuid) ) docs.set(uuid, fromUuid(uuid).catch(() => null));
  return docs.get(uuid);
}

/**
 * The first visible entry of a type whose name matches (case-insensitive), preferring exact matches.
 * @param {string} type
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function findByName(type, name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  if ( !wanted ) return null;
  const list = (await contentIndex())[type] ?? [];
  const lower = e => e.name.toLowerCase();
  return list.find(e => lower(e) === wanted)
    ?? list.find(e => lower(e).startsWith(`${wanted} `) || lower(e).startsWith(`${wanted},`))
    ?? null;
}

/* -------------------------------------------- */
/*  The book's markup                           */
/* -------------------------------------------- */

/**
 * The book's markup in one pattern: `@UUID[uuid]{label}` links (label optional), references written as
 * `@type name|system` in braces plus `[label]` (not enriched by the system; matched to items by name) and inline
 * rolls `[[/r formula]]`.
 */
const MARKUP_RE = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?|\{@(\w+) ([^|}]+)\|[^}]*\}(?:\[([^\]]*)\])?|\[\[\/r ([^\]]+)\]\]/g;

/**
 * The links and references in a text: `[{ uuid, label }]` and `[{ refType, name, label }]`.
 * @param {string|undefined} text
 * @returns {object[]}
 */
export function linkedRefs(text) {
  const refs = [];
  for ( const m of String(text ?? "").matchAll(MARKUP_RE) ) {
    if ( m[1] ) refs.push({ uuid: m[1], label: m[2] ?? "" });
    else if ( m[3] ) refs.push({ refType: m[3], name: m[4].trim(), label: m[5] ?? m[4].trim() });
  }
  return refs;
}

/**
 * A book text with its markup replaced by labels / names (links without a label vanish), without HTML parsing.
 * @param {string|undefined} text
 * @returns {string}
 */
export function stripMarkup(text) {
  return String(text ?? "").replace(MARKUP_RE, (_, uuid, label, refType, name, refLabel, formula) => {
    if ( uuid ) return label ?? "";
    if ( refType ) return refLabel ?? name;
    return formula;
  });
}

/**
 * Language names an ancestry or path text grants (references written as `@language Name|…` in braces).
 * @param {string|undefined} text
 * @returns {string[]}
 */
export function languageNames(text) {
  return linkedRefs(text).filter(r => r.refType === "language").map(r => r.name);
}

/**
 * Plain text from an HTML string.
 * @param {string} html
 * @returns {string}
 */
function plainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Readable plain text of a book text: links become their label (an unlabeled link the linked document's name),
 * references their label, inline rolls their formula. Used for every book text the builder shows; cached per text.
 * @param {string|undefined} text
 * @returns {Promise<string>}
 */
export function displayText(text) {
  const source = String(text ?? "");
  if ( !texts.has(source) ) texts.set(source, (async () => {
    const unlabeled = [...new Set([...source.matchAll(MARKUP_RE)].filter(m => m[1] && (m[2] == null)).map(m => m[1]))];
    const names = new Map(await Promise.all(unlabeled.map(async u => [u, await linkName(u)])));
    const fallback = game.i18n.localize("AVTTSB.LinkedEntry");
    return plainText(source.replace(MARKUP_RE, (_, uuid, label, refType, name, refLabel, formula) => {
      if ( uuid ) return label ?? (names.get(uuid) || fallback);
      if ( refType ) return refLabel ?? name;
      return formula;
    }));
  })());
  return texts.get(source);
}

/**
 * The name of a linked document without loading it: compendium entries from the pack's index (only packs the user
 * can see), world documents from their collection. Embedded documents (such as the book's journal pages, whose
 * parent is one ~20 MB entry) aren't resolved. Empty when unknown.
 * @param {string} uuid
 * @returns {Promise<string>}
 */
function linkName(uuid) {
  if ( !linkNames.has(uuid) ) linkNames.set(uuid, (async () => {
    const parsed = foundry.utils.parseUuid(uuid);
    if ( !parsed?.collection || parsed.embedded?.length ) return "";
    const { collection, id } = parsed;
    if ( typeof collection.getIndex === "function" ) {
      if ( !collection.visible ) return "";
      return (await collection.getIndex()).get(id)?.name ?? "";
    }
    return collection.get?.(id)?.name ?? "";
  })().catch(() => ""));
  return linkNames.get(uuid);
}

/* -------------------------------------------- */
/*  Roll tables                                 */
/* -------------------------------------------- */

/**
 * RollTables linked from a description (an ancestry's Age, Build, Background, … tables): `[{ uuid, name }]`.
 * @param {string} html
 * @returns {Promise<{uuid: string, name: string}[]>}
 */
export async function linkedTables(html) {
  const uuids = linkedRefs(html).map(r => r.uuid).filter(u => u?.includes("RollTable"));
  const found = await Promise.all(uuids.map(getDoc));
  return found.filter(t => t instanceof RollTable).map(t => ({ uuid: t.uuid, name: t.name }));
}

/**
 * A world or compendium RollTable by name (first match), looked up once per name.
 * @param {string} name
 * @returns {Promise<RollTable|null>}
 */
export function findTable(name) {
  if ( !tables.has(name) ) tables.set(name, (async () => {
    const local = game.tables.getName(name);
    if ( local ) return local;
    for ( const pack of game.packs ) {
      if ( (pack.documentName !== "RollTable") || !pack.visible ) continue;
      const entry = (await pack.getIndex()).getName(name);
      if ( entry ) return getDoc(entry.uuid);
    }
    return null;
  })());
  return tables.get(name);
}

/**
 * Roll a table without posting to chat; nested tables are followed. Returns `{ total, text }`.
 * @param {RollTable} table
 * @returns {Promise<{total: number|null, text: string}>}
 */
export async function rollTable(table) {
  const { roll, results } = await table.roll();
  const parts = await Promise.all(results.map(r => displayText(r.description || r.name)));
  return { total: roll?.total ?? null, text: parts.filter(Boolean).join(" ") };
}

/**
 * A table's entries for picking by hand: `[{ label, options: [{ range, text }] }]`, sorted by range. Results that are
 * other RollTables (the Interesting Things table of tables) become one group each, one level deep; a plain table is
 * one group without label. Cached per table (with the documents).
 * @param {RollTable} table
 * @returns {Promise<object[]>}
 */
export function tableEntries(table) {
  const key = `entries:${table.uuid}`;
  if ( !texts.has(key) ) texts.set(key, readEntries(table, 0));
  return texts.get(key);
}

/**
 * A table's results as groups of range / text options; at depth 0, results that are tables become groups of their own.
 * @param {RollTable} table
 * @param {number} depth
 * @returns {Promise<object[]>}
 */
async function readEntries(table, depth) {
  const range = r => (!r.range || (r.range[0] === r.range[1]) ? String(r.range?.[0] ?? "") : `${r.range[0]}–${r.range[1]}`);
  const sorted = [...table.results].sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0));
  const read = await Promise.all(sorted.map(async result => {
    const nested = (depth === 0) && (result.type === "document") && result.documentUuid?.includes("RollTable");
    const inner = nested ? await getDoc(result.documentUuid) : null;
    if ( inner instanceof RollTable ) {
      const [group] = await readEntries(inner, depth + 1);
      return { group: group && { label: `${range(result)}: ${inner.name}`, options: group.options } };
    }
    return { option: { range: range(result), text: await displayText(result.description || result.name) } };
  }));
  const own = read.map(r => r.option).filter(o => o?.text);
  const groups = read.map(r => r.group).filter(g => g?.options.length);
  return own.length ? [{ label: "", options: own }, ...groups] : groups;
}

/* -------------------------------------------- */
/*  Professions                                 */
/* -------------------------------------------- */

/**
 * Roll a random profession as the book describes: the Profession Types table picks a kind (its result starts with
 * the kind in bold), then that kind's "<Kind> Professions" table picks the profession.
 * @returns {Promise<{name: string, text: string, kind: string}|null>}
 */
export async function rollProfession() {
  const types = await findTable("Profession Types");
  if ( !types ) return null;
  const first = await rollTable(types);
  const kind = /^\s*([A-Za-z]+)/.exec(first.text)?.[1] ?? "";
  const table = kind ? await findTable(`${kind} Professions`) : null;
  if ( !table ) return null;
  const drawn = await rollTable(table);
  const name = drawn.text.split(/[.:]/)[0].trim();
  return name ? { name, text: drawn.text, kind } : null;
}

/* -------------------------------------------- */
/*  Wealth and starting equipment               */
/* -------------------------------------------- */

/**
 * Roll the Wealth table (3d6). Returns `{ total, lifestyle }` or null when the table isn't available.
 * @returns {Promise<{total: number|null, lifestyle: string|null}|null>}
 */
export async function rollWealth() {
  const table = await findTable("Wealth");
  if ( !table ) return null;
  const { total, text } = await rollTable(table);
  return { total, lifestyle: LIFESTYLES.find(l => text.startsWith(l)) ?? null };
}

/**
 * The starting equipment of each lifestyle, read from the book page set in the "equipmentPage" setting:
 * `{ [lifestyle]: { text, items: [{ uuid, name, img, label }], coins: { formula, coin } | null } }`. Loaded only on
 * request (the core book is one large journal; only the parsed kits are kept). Null when the page isn't available.
 * @returns {Promise<object|null>}
 */
export async function loadEquipmentKits() {
  if ( equipmentKits ) return equipmentKits;
  const uuid = game.settings.get(MODULE_ID, "equipmentPage");
  const page = uuid ? await fromUuid(uuid).catch(() => null) : null;
  const html = page?.text?.content;
  if ( !html ) return null;
  const div = document.createElement("div");
  div.innerHTML = html;
  const kits = {};
  await Promise.all([...div.querySelectorAll("p")].map(async p => {
    const lifestyle = p.querySelector("b, strong")?.textContent.trim();
    if ( !LIFESTYLES.includes(lifestyle) ) return;
    const source = p.innerHTML.replace(/^\s*<(b|strong)>[^<]*<\/\1>\s*:?\s*/, "");
    const coin = /\[\[\/r ([^\]]+)\]\]\s*(bits|cp|ss|gc)\b/.exec(source);
    kits[lifestyle] = {
      text: await displayText(source),
      items: await kitItems(linkedRefs(source)),
      coins: coin ? { formula: coin[1].trim(), coin: coin[2] } : null
    };
  }));
  equipmentKits = Object.keys(kits).length ? kits : null;
  return equipmentKits;
}

/**
 * A kit's linked items as visible equipment entries (unresolved ones are left out; the kit text shows them).
 * @param {object[]} refs
 * @returns {Promise<object[]>}
 */
async function kitItems(refs) {
  const index = await contentIndex();
  const types = { weapon: "weapon", armor: "armor", ammunition: "ammo", item: "item" };
  const out = new Map();
  for ( const ref of refs ) {
    const entry = ref.uuid ? index.byUuid.get(ref.uuid) : await findByName(types[ref.refType], ref.name);
    if ( !entry || !EQUIPMENT_TYPES.includes(entry.type) || out.has(entry.uuid) ) continue;
    out.set(entry.uuid, { uuid: entry.uuid, name: entry.name, img: entry.img, label: ref.label || entry.name });
  }
  return [...out.values()];
}
