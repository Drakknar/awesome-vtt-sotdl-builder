/**
 * Part of awesome-vtt-sotdl-builder: the character builder window.
 *
 * One window walks the whole build, as Hero Mancer does for dnd5e: a sidebar with a live preview (portrait, scores,
 * characteristics) and the steps with badges for the choices still left, the current step in the middle, and
 * Back / Next / Create in the footer. A new character's plan is saved as a draft on the user (flag) while it changes,
 * so closing the window keeps it.
 *
 * Opened with an actor, the same window levels that character up: only the Paths, Magic, Professions and Review
 * steps, for the levels it gains (see rules.mjs, `fromLevel`).
 */

import { APPEARANCE, ATTRS, CHARACTERISTICS, COINS, LEVELS, LIFESTYLES, LIMITS, MODULE_ID, STEPS, TIERS, TRAIT_FIELDS } from "./constants.mjs";
import { contentIndex, displayText, findByName, findTable, getDoc, linkedTables, loadEquipmentKits, rollProfession,
  rollTable, rollWealth, tableEntries } from "./content.mjs";
import { allLanguages, allSpells, ancestryBase, ancestryL4, ancestryLanguages, attrChoiceCount, chosenTalents,
  computeStats, gainsL4, guidance, hasAncestryBonus, knownTraditions, l4Missing, levelGains, levelKey, levelMissing,
  levelUpStats, magicAllowance, newLevels, newPlan, ownedBuild, ownedNames, pickId, professionAllowance, pruneChoices,
  remaining, sizeOptions, tiersFor } from "./rules.mjs";
import { cleanCount, cleanText, createCharacter, levelUpCharacter, sanitizePlan } from "./create.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const loc = key => game.i18n.localize(key);
const fmt = (key, data) => game.i18n.format(key, data);
const signed = n => Number(n).signedString();
const TEMPLATES = `modules/${MODULE_ID}/templates`;

/**
 * Plan fields a form control may set by its `name`: the value's kind, its length limit, and what to re-render
 * (`true` everything, a list of parts, or nothing; pickers with `data-picker` always re-render).
 */
const field = (kind, render = false, max = LIMITS.text) => ({ kind, render, max });
const FIELDS = {
  "name": field("text", ["sidebar", "footer"], LIMITS.name),
  "ancestry.size": field("text", true, 8),
  "ancestry.bonus": field("attr", true),
  "ancestry.adjustUp": field("attr", true),
  "ancestry.adjustDown": field("attr", true),
  "ancestry.l4": field("text", true, 8),
  "ancestry.l4Spell": field("text", true, 200),
  "equipment.lifestyle": field("text", true, 20),
  "bio.religion": field("text", false, 500),
  "bio.interesting": field("text", false, 1000),
  "bio.notes": field("text"),
  ...Object.fromEntries(APPEARANCE.map(k => [`bio.appearance.${k}`, field("text", false, 200)])),
  ...Object.fromEntries(COINS.map(c => [`equipment.coins.${c}`, field("count")]))
};

/** Lists the remove buttons may change (`data-list`). */
const LISTS = { professions: plan => plan.professions, languages: plan => plan.languages, items: plan => plan.equipment.items,
  spells: plan => plan.spells };

export default class CharacterBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ actor = null, name, ...options } = {}) {
    super(actor ? { ...options, id: CharacterBuilder.levelUpId(actor) } : options);
    this.actor = actor;
    if ( actor ) {
      this.plan = CharacterBuilder.levelUpPlan(actor);
      this.step = "paths";
    } else {
      const draft = game.user.getFlag(MODULE_ID, "draft");
      this.plan = draft?.plan ? sanitizePlan(draft.plan) : newPlan(CharacterBuilder.defaultLevel());
      if ( !this.canSetLevel ) this.plan.level = CharacterBuilder.defaultLevel();
      if ( name ) this.plan.name = cleanText(name, LIMITS.name);
      this.step = STEPS.some(s => s.id === draft?.step) ? draft.step : "ancestry";
    }
    this.docs = {};
    this.stepIds = [];
    this.filters = { spellTradition: "" };
    this.kits = null;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-builder`,
    classes: ["avtsb-builder"],
    window: { title: "AVTTSB.Title", icon: "fa-solid fa-skull", resizable: true },
    position: { width: 1020, height: 760 },
    actions: {
      step: CharacterBuilder.#onStep,
      next: CharacterBuilder.#onNext,
      back: CharacterBuilder.#onBack,
      submit: CharacterBuilder.#onSubmit,
      restart: CharacterBuilder.#onRestart,
      loadKits: CharacterBuilder.#onLoadKits,
      showItem: CharacterBuilder.#onShowItem,
      pickImage: CharacterBuilder.#onPickImage,
      pickAncestry: CharacterBuilder.#edit(CharacterBuilder.#onPickAncestry),
      pickPath: CharacterBuilder.#edit(CharacterBuilder.#onPickPath),
      toggleAttr: CharacterBuilder.#edit(CharacterBuilder.#onToggleAttr),
      pickTalent: CharacterBuilder.#edit(CharacterBuilder.#onPickTalent),
      addTradition: CharacterBuilder.#edit(CharacterBuilder.#onAddTradition),
      removeTradition: CharacterBuilder.#edit(CharacterBuilder.#onRemoveTradition),
      addSpell: CharacterBuilder.#edit(CharacterBuilder.#onAddSpell),
      addProfession: CharacterBuilder.#edit(CharacterBuilder.#onAddProfession),
      addCustomProfession: CharacterBuilder.#edit(CharacterBuilder.#onAddCustomProfession),
      rollProfession: CharacterBuilder.#edit(CharacterBuilder.#onRollProfession),
      addLanguage: CharacterBuilder.#edit(CharacterBuilder.#onAddLanguage),
      removeAt: CharacterBuilder.#edit(CharacterBuilder.#onRemoveAt),
      rollTrait: CharacterBuilder.#edit(CharacterBuilder.#onRollTrait),
      rollInteresting: CharacterBuilder.#edit(CharacterBuilder.#onRollInteresting),
      rollWealth: CharacterBuilder.#edit(CharacterBuilder.#onRollWealth),
      addItem: CharacterBuilder.#edit(CharacterBuilder.#onAddItem),
      rollCoins: CharacterBuilder.#edit(CharacterBuilder.#onRollCoins),
      rollLevelCoins: CharacterBuilder.#edit(CharacterBuilder.#onRollLevelCoins)
    }
  };

  static PARTS = {
    sidebar: { template: `${TEMPLATES}/sidebar.hbs` },
    body: { template: `${TEMPLATES}/body.hbs`, scrollable: [""] },
    footer: { template: `${TEMPLATES}/footer.hbs` }
  };

  /** Templates registered as partials: each step (`avtsb-step-<id>`) and the guidance notes. */
  static PARTIALS = {
    ...Object.fromEntries(STEPS.map(s => [`avtsb-step-${s.id}`, `${TEMPLATES}/steps/${s.id}.hbs`])),
    "avtsb-guidance": `${TEMPLATES}/guidance.hbs`
  };

  /** The starting level from the world setting. */
  static defaultLevel() {
    return Math.clamp(Number(game.settings.get(MODULE_ID, "startLevel")) || 0, 0, LIMITS.level);
  }

  /** The level-up window's id for an actor (one window per character). */
  static levelUpId(actor) {
    return `${MODULE_ID}-levelup-${actor.id}`;
  }

  /** A level-up plan for an actor: one level up, with the ancestry and paths it has. */
  static levelUpPlan(actor) {
    const from = Number(actor.system.level) || 0;
    const plan = newPlan(Math.min(from + 1, LIMITS.level), from);
    plan.name = actor.name;
    plan.img = actor.img;
    const owned = ownedBuild(actor);
    plan.ancestry.uuid = owned.ancestry?.uuid ?? null;
    for ( const tier of TIERS ) plan.paths[tier.id].uuid = owned[tier.id]?.uuid ?? null;
    return plan;
  }

  /** Can the current user change the level in the window? */
  get canSetLevel() {
    return game.user.isGM || game.settings.get(MODULE_ID, "playersChooseLevel");
  }

  /** @override */
  get title() {
    return this.actor ? fmt("AVTTSB.LevelUp.Title", { name: this.actor.name }) : super.title;
  }

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /** Load the documents the plan names (ancestry and paths), in parallel. */
  async #syncDocs() {
    const uuids = [this.plan.ancestry.uuid, ...TIERS.map(t => this.plan.paths[t.id].uuid)];
    const [ancestry, ...paths] = await Promise.all(uuids.map(getDoc));
    this.docs = { ancestry, ...Object.fromEntries(TIERS.map((t, i) => [t.id, paths[i]])) };
  }

  /** Save a new character's plan as this user's draft (debounced). */
  #saveDraft = foundry.utils.debounce(() => {
    if ( !this.actor ) game.user.setFlag(MODULE_ID, "draft", { plan: this.plan, step: this.step }).catch(() => null);
  }, 800);

  /** The plan changed: save the draft and re-render (`true` all, a list of parts, or nothing). */
  async #changed({ render = true } = {}) {
    this.#saveDraft();
    if ( render ) await this.render(render === true ? {} : { parts: render });
  }

  /** An action that changes the plan: saved and re-rendered afterwards, unless it returns `false`. */
  static #edit(fn) {
    return async function(event, target) {
      if ( (await fn.call(this, event, target)) !== false ) await this.#changed();
    };
  }

  /** Run an async task once at a time, reporting errors. Returns its result, or `false` if it didn't run or failed. */
  async #once(fn) {
    if ( this.running ) return false;
    this.running = true;
    try {
      return await fn();
    } catch(err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(err.message);
      return false;
    } finally {
      this.running = false;
    }
  }

  /** @override */
  async _prepareContext(options) {
    [this.index] = await Promise.all([contentIndex(), this.#syncDocs()]);
    pruneChoices(this.plan, this.docs);
    const stats = this.actor ? levelUpStats(this.plan, this.docs, this.actor) : computeStats(this.plan, this.docs);
    // Kept for the actions' limit checks and the submit check.
    this.known = knownTraditions(this.actor);
    const allowance = this.allowance = professionAllowance(this.plan, this.docs);
    this.magic = magicAllowance(this.plan, this.docs, { power: stats.power, known: this.known,
      spellInfo: uuid => this.index.byUuid.get(uuid) });
    const missing = this.missing = remaining(this.plan, this.docs, allowance, this.magic);
    const steps = STEPS.filter(s => !(this.actor && s.createOnly) && (!s.when || s.when(this.plan, { stats, magic: this.magic })));
    this.stepIds = steps.map(s => s.id);
    if ( !this.stepIds.includes(this.step) ) this.step = this.stepIds[0];
    const position = this.stepIds.indexOf(this.step);
    return {
      plan: this.plan,
      levelUp: !!this.actor,
      stats,
      allowance,
      missing,
      steps: steps.map(s => ({ ...s, label: loc(`AVTTSB.Step.${s.id}`), active: s.id === this.step,
        missing: s.id === "review" ? 0 : missing[s.id] })),
      isFirst: position === 0,
      isLast: position === steps.length - 1,
      progress: { value: steps.filter(s => s.id !== "review" && !missing[s.id]).length, max: Math.max(1, steps.length - 1) },
      canSubmit: !missing.review,
      submitLabel: loc(this.actor ? "AVTTSB.LevelUp.Submit" : "AVTTSB.Footer.Create"),
      canSetLevel: this.canSetLevel,
      levelChoices: Object.fromEntries(LEVELS.filter(n => n > this.plan.fromLevel).map(n => [n, String(n)])),
      selectedLevel: String(this.plan.level),
      hud: this.#hudContext(stats)
    };
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( partId !== "body" ) return context;
    const hintKey = `AVTTSB.LevelUp.Hint.${this.step}`;
    context.stepPartial = `avtsb-step-${this.step}`;
    context.stepTitle = loc(`AVTTSB.Step.${this.step}`);
    context.stepHint = loc(this.actor && game.i18n.has(hintKey) ? hintKey : `AVTTSB.Hint.${this.step}`);
    return Object.assign(context, await this.#stepContext(context));
  }

  /** The current step's own context. */
  #stepContext(context) {
    switch ( this.step ) {
      case "ancestry": return this.#ancestryContext();
      case "attributes": return this.#attributesContext(context);
      case "paths": return this.#pathsContext();
      case "magic": return this.#magicContext(context);
      case "professions": return this.#professionsContext(context);
      case "background": return this.#backgroundContext();
      case "equipment": return this.#equipmentContext();
      case "review": return this.#reviewContext(context);
    }
  }

  #hudContext(stats) {
    const { ancestry } = this.docs;
    const paths = TIERS.map(t => this.docs[t.id]?.name).filter(Boolean);
    const level = this.actor ? fmt("AVTTSB.LevelUp.Levels", { from: this.plan.fromLevel, to: this.plan.level })
      : fmt("AVTTSB.Hud.Level", { level: this.plan.level });
    return {
      img: this.plan.img || ancestry?.img || "icons/svg/mystery-man.svg",
      name: this.plan.name || loc("AVTTSB.Hud.Unnamed"),
      line: [level, ancestry?.name, ...paths].filter(Boolean).join(" · "),
      scores: ATTRS.map(a => ({ key: a, label: loc(`AVTTSB.Attr.${a}`), value: stats.scores[a], mod: signed(stats.modifiers[a]) })),
      characteristics: [
        ["health", stats.health], ["healingRate", stats.healingRate], ["defense", stats.defense],
        ["perception", stats.perception], ["speed", stats.speed], ["size", stats.size], ["power", stats.power],
        ["insanity", `0 / ${stats.insanityMax}`]
      ].map(([key, value]) => ({ key, label: loc(`AVTTSB.Char.${key}`), value }))
    };
  }

  /* -------------------------------------------- */
  /*  Step contexts                               */
  /* -------------------------------------------- */

  async #ancestryContext() {
    const doc = this.docs.ancestry;
    const base = ancestryBase(doc);
    const sizes = sizeOptions(doc);
    const l4 = ancestryL4(doc);
    return {
      choices: this.index.ancestry.map(e => ({ ...e, selected: e.uuid === this.plan.ancestry.uuid })),
      selected: doc ? {
        name: doc.name,
        img: doc.img,
        description: await foundry.applications.ux.TextEditor.implementation.enrichHTML(doc.system.description ?? "", { secrets: false }),
        sizes: sizes.length > 1 ? sizes.map(s => ({ value: s, checked: this.plan.ancestry.size === s })) : null,
        talents: (base?.talents ?? []).map(t => ({ name: t.name, uuid: t.uuid })),
        languages: await displayText(base?.languagesText),
        level4: l4 ? fmt("AVTTSB.Ancestry.Level4", { talent: l4.talentspick.map(t => t.name).join(", ") }) : ""
      } : null
    };
  }

  #attributesContext(context) {
    const base = ancestryBase(this.docs.ancestry);
    const { bonus, adjustUp, adjustDown } = this.plan.ancestry;
    const choices = exclude => Object.fromEntries(ATTRS.filter(a => a !== exclude).map(a => [a, loc(`AVTTSB.Attr.${a}`)]));
    return {
      noAncestry: !this.docs.ancestry,
      hasBonus: hasAncestryBonus(this.docs.ancestry),
      rows: ATTRS.map(a => {
        const change = (adjustUp === a ? 1 : 0) - (adjustDown === a ? 1 : 0);
        return {
          key: a,
          label: loc(`AVTTSB.Attr.${a}`),
          base: Number(base?.attributes?.[a]?.value) || 10,
          bonus: bonus === a,
          change: change ? signed(change) : "—",
          final: context.stats.scores[a],
          mod: signed(context.stats.modifiers[a])
        };
      }),
      upChoices: choices(adjustDown),
      downChoices: choices(adjustUp)
    };
  }

  /** One gained level of a path for the Paths step. */
  async #levelContext(tier, level, choices) {
    const key = levelKey(level);
    const choice = choices[key] ?? {};
    const attrs = choice.attrs ?? [];
    const want = attrChoiceCount(level);
    const missing = levelMissing(level, choices);
    const [picks, notes] = await Promise.all([
      Promise.all((level.talentspick ?? []).map(async t => ({
        id: pickId(t), name: t.name, checked: choice.pick === pickId(t),
        text: await displayText(t.description ?? t.system?.description)
      }))),
      Promise.all(["languagesText", "magicText", "equipmentText", "optionsText"].filter(f => level[f]).map(f => displayText(level[f])))
    ]);
    return {
      tier,
      level: key,
      characteristics: bonusText(CHARACTERISTICS.map(k => [`AVTTSB.Char.${k}`, level.characteristics?.[k]])),
      attrHint: want ? fmt("AVTTSB.Paths.ChooseAttrs", { n: want, value: Number(level.attributes?.strength?.value) || 1 }) : "",
      attrCount: fmt("AVTTSB.Count", { n: attrs.length, max: want }),
      attrs: want ? ATTRS.map(a => ({
        key: a, label: loc(`AVTTSB.Attr.${a}`), checked: attrs.includes(a), disabled: !attrs.includes(a) && (attrs.length >= want)
      })) : null,
      talents: [...(level.talents ?? []), ...(level.spells ?? [])].map(t => ({ name: t.name, uuid: t.uuid })),
      picks,
      pickCount: fmt("AVTTSB.Count", { n: choice.pick ? 1 : 0, max: 1 }),
      notes,
      missing: missing.attrs + missing.pick
    };
  }

  async #pathsContext() {
    const tiers = await Promise.all(tiersFor(this.plan.level).map(async tier => {
      const doc = this.docs[tier.id];
      const owned = !!doc && (tier.from <= this.plan.fromLevel);
      const levels = newLevels(doc, this.plan);
      if ( owned && !levels.length ) return null;
      const choices = this.plan.paths[tier.id].choices;
      return {
        id: tier.id,
        label: loc(`AVTTSB.Tier.${tier.id}`),
        hint: fmt("AVTTSB.Paths.TierHint", { level: tier.from }),
        owned,
        options: owned ? [] : this.index.path.filter(e => e.pathType === tier.id)
          .map(e => ({ ...e, selected: e.uuid === this.plan.paths[tier.id].uuid })),
        selected: doc ? {
          name: doc.name, uuid: doc.uuid,
          levels: await Promise.all(levels.map(l => this.#levelContext(tier.id, l, choices)))
        } : null
      };
    }));
    let ancestryLevel4 = null;
    if ( gainsL4(this.plan, this.docs.ancestry) ) {
      const { l4, l4Spell } = this.plan.ancestry;
      ancestryLevel4 = {
        talent: ancestryL4(this.docs.ancestry).talentspick.map(t => t.name).join(", "),
        isTalent: l4 === "talent",
        isSpell: l4 === "spell",
        spellChoices: Object.fromEntries(this.index.spell.filter(this.magic.learnable)
          .map(s => [s.uuid, `${s.name} (${s.tradition} ${s.rank})`])),
        noTraditions: !this.magic.discovered.length,
        l4Spell,
        missing: l4Missing(this.plan, this.docs.ancestry)
      };
    }
    return { tiers: tiers.filter(Boolean), ancestryLevel4 };
  }

  async #magicContext(context) {
    const power = context.stats.power;
    const magic = this.magic;
    const { spellTradition } = this.filters;
    const info = uuid => this.index.byUuid.get(uuid) ?? { uuid, name: uuid, tradition: "", rank: "?" };
    const taken = new Set([...this.plan.spells, ...this.plan.traditions.map(t => t.spell)]);
    const own = ownedNames(this.actor, "spell");
    const rankZero = name => Object.fromEntries(this.index.spell.filter(s => (s.tradition === name) && (s.rank === 0)
      && !own.has(s.name.toLowerCase())).map(s => [s.uuid, s.name]));
    const addable = [...new Set(this.index.spell.map(s => s.tradition).filter(Boolean))].sort().filter(magic.canAddTradition);
    return {
      power,
      castings: (CASTINGS[Math.clamp(power, 0, 10)]).map((n, rank) => ({ rank, n })),
      guidance: await displayGuidance(guidance(this.plan, this.docs, "magicText")),
      noGrants: !magic.grants,
      traditionCount: fmt("AVTTSB.Count", { n: magic.traditions, max: magic.maxTraditions }),
      spellCount: fmt("AVTTSB.Count", { n: magic.spells, max: magic.maxSpells }),
      knownTraditions: this.known.join(", "),
      traditions: this.plan.traditions.map((t, index) => ({ ...t, index, spellChoices: rankZero(t.name) })),
      addableTraditions: Object.fromEntries(addable.map(t => [t, t])),
      canAddTradition: addable.length > 0,
      spellTraditions: Object.fromEntries(magic.discovered.map(t => [t, t])),
      spellTradition,
      spells: this.index.spell.filter(s => magic.learnable(s) && !taken.has(s.uuid)
        && !own.has(s.name.toLowerCase()) && (!spellTradition || (s.tradition === spellTradition)))
        .map(s => ({ ...s, disabled: !magic.canAddSpell(s) })),
      chosen: this.plan.spells.map((uuid, index) => ({ ...info(uuid), index })),
      over: magic.over,
      l4Spell: this.plan.ancestry.l4 === "spell"
    };
  }

  async #professionsContext(context) {
    const { allowance } = context;
    const lower = s => s.toLowerCase();
    const auto = this.actor ? [] : ancestryLanguages(this.docs.ancestry);
    const flagsOf = name => this.plan.languages.find(l => lower(l.name) === lower(name));
    const taken = new Set([...auto, ...this.plan.languages.map(l => l.name)].map(lower).concat([...ownedNames(this.actor, "language")]));
    const chosen = new Set(this.plan.professions.map(p => p.uuid).filter(Boolean));
    const ownProfessions = ownedNames(this.actor, "profession");
    return {
      professionCount: fmt("AVTTSB.Count", { n: allowance.professions, max: allowance.maxProfessions }),
      languageCount: fmt("AVTTSB.Count", { n: allowance.languages, max: allowance.maxLanguages }),
      allowanceText: fmt("AVTTSB.Professions.Allowance", {
        professions: allowance.professions, maxProfessions: allowance.maxProfessions, used: allowance.used, budget: allowance.budget
      }),
      guidance: await displayGuidance(guidance(this.plan, this.docs, "languagesText")),
      professions: this.plan.professions.map((p, index) => ({ ...p, index })),
      professionList: this.index.profession.filter(p => !chosen.has(p.uuid) && !ownProfessions.has(lower(p.name))),
      canRoll: !!(await findTable("Profession Types")),
      languages: [
        ...auto.map(name => ({ name, auto: true, read: !!flagsOf(name)?.read, write: !!flagsOf(name)?.write })),
        ...this.plan.languages.map((l, index) => ({ ...l, index })).filter(l => !l.auto && !auto.some(a => lower(a) === lower(l.name)))
      ],
      languageOptions: this.index.language.filter(l => !taken.has(lower(l.name)))
    };
  }

  async #backgroundContext() {
    const ancestryName = this.docs.ancestry?.name;
    const traits = new Map(this.plan.bio.traits.map(t => [t.label, t.text]));
    const tables = this.docs.ancestry ? await linkedTables(this.docs.ancestry.system.description) : [];
    const interesting = await findTable("Interesting Things Tables");
    const rows = await Promise.all(tables.map(async t => {
      const label = traitLabel(t.name, ancestryName);
      return { ...t, label, text: traits.get(label) ?? "", entries: entryChoices(await tableEntries(await getDoc(t.uuid))) };
    }));
    return {
      tables: rows,
      interesting: interesting ? entryChoices(await tableEntries(interesting)) : null,
      appearance: APPEARANCE.map(k => ({ key: k, label: loc(`AVTTSB.Appearance.${k}`), value: this.plan.bio.appearance[k] ?? "" }))
    };
  }

  async #equipmentContext() {
    const { equipment } = this.plan;
    const kit = this.kits?.[equipment.lifestyle] ?? null;
    const owned = new Set(equipment.items.map(i => i.uuid));
    return {
      lifestyles: Object.fromEntries(LIFESTYLES.map(l => [l, l])),
      canRollWealth: !!(await findTable("Wealth")),
      kitsAvailable: !!game.settings.get(MODULE_ID, "equipmentPage"),
      kitsLoaded: !!this.kits,
      kit: kit && { ...kit, items: kit.items.map(e => ({ ...e, owned: owned.has(e.uuid) })) },
      items: equipment.items.map((i, index) => ({ ...i, index })),
      catalog: this.index.equipment,
      coins: COINS.map(c => ({ key: c, label: loc(`AVTTSB.Coin.${c}`), value: equipment.coins[c] })),
      levelCoins: this.plan.level > 0 ? fmt("AVTTSB.Equipment.LevelCoins", { n: this.plan.level }) : ""
    };
  }

  #reviewContext(context) {
    const plan = this.plan;
    const join = list => (list.length ? list.join(", ") : "—");
    const nameOf = uuid => this.index.byUuid.get(uuid)?.name ?? "";
    const row = (label, value) => ({ label: loc(label), value: value || "—" });
    const tiers = tiersFor(plan.level).filter(t => t.from > plan.fromLevel);
    const rows = [
      ...(this.actor ? [] : [row("AVTTSB.Background.Name", plan.name), row("AVTTSB.Step.ancestry", this.docs.ancestry?.name)]),
      row("AVTTSB.Review.Level", this.actor ? fmt("AVTTSB.LevelUp.Levels", { from: plan.fromLevel, to: plan.level }) : String(plan.level)),
      ...tiers.map(t => ({ label: loc(`AVTTSB.Tier.${t.id}`), value: this.docs[t.id]?.name ?? "—" })),
      ...(this.actor ? [row("AVTTSB.LevelUp.Gains", gainsText(levelGains(plan, this.docs)))] : []),
      row("AVTTSB.Review.Talents", join(chosenTalents(plan, this.docs).map(t => `${t.name} (${t.source})`))),
      row("AVTTSB.Magic.Chosen", join(allSpells(plan).map(nameOf).filter(Boolean))),
      row("AVTTSB.Professions.Title", join(plan.professions.map(p => p.name))),
      row("AVTTSB.Languages.Title", join((this.actor ? plan.languages : allLanguages(plan, this.docs.ancestry)).map(l => l.name)))
    ];
    if ( !this.actor ) rows.push(
      row("AVTTSB.Equipment.Lifestyle", plan.equipment.lifestyle),
      row("AVTTSB.Equipment.Items", join(plan.equipment.items.map(i => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)))),
      row("AVTTSB.Equipment.Coins", COINS.filter(c => plan.equipment.coins[c]).map(c => `${plan.equipment.coins[c]} ${loc(`AVTTSB.Coin.${c}`)}`).join(", "))
    );
    return {
      rows,
      problems: context.steps.filter(s => s.missing).map(s => fmt("AVTTSB.Review.Missing", { step: s.label, n: s.missing })),
      after: loc(this.actor ? "AVTTSB.LevelUp.After" : "AVTTSB.Review.After")
    };
  }

  /* -------------------------------------------- */
  /*  Form fields and filters                     */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("change", this.#onChangeField.bind(this));
    this.element.addEventListener("input", event => {
      if ( event.target.matches("input[data-filter]") ) this.#applyFilter(event.target);
    });
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const input of this.element.querySelectorAll("input[data-filter]") ) {
      input.value = this.filters[`search:${input.dataset.filter}`] ?? "";
      this.#applyFilter(input);
    }
  }

  /** A form control changed: a filter, a language's read / write mark, a quantity, a background trait or a plan field. */
  async #onChangeField(event) {
    const el = event.target;
    const data = el.dataset;
    const picker = "picker" in data;
    if ( picker && !el.value ) return;
    if ( "filterTradition" in data ) {
      this.filters.spellTradition = el.value;
      return this.render({ parts: ["body"] });
    }
    if ( data.language ) {
      this.#setLanguageFlag(data.language, data.flag, el.checked);
      return this.#changed({ render: false });
    }
    if ( data.traditionSpell ) {
      const tradition = this.plan.traditions[Number(data.traditionSpell)];
      // The rank 0 spells of that tradition are the only options; magicAllowance flags anything else.
      if ( tradition ) tradition.spell = this.index.byUuid.has(el.value) ? el.value : null;
      return this.#changed();
    }
    if ( data.itemQty ) {
      const item = this.plan.equipment.items[Number(data.itemQty)];
      if ( item ) item.qty = Math.max(1, cleanCount(el.value, 999));
      return this.#changed({ render: false });
    }
    if ( "trait" in data ) {
      this.#setTrait(data.trait, cleanText(el.value, 1000));
      return this.#changed({ render: picker });
    }
    if ( el.name === "level" ) {
      if ( !this.canSetLevel ) return;
      this.plan.level = Math.clamp(Number(el.value) || 0, Math.max(0, this.plan.fromLevel + 1), LIMITS.level);
      return this.#changed();
    }
    const spec = FIELDS[el.name];
    if ( !spec ) return;
    let value;
    if ( spec.kind === "attr" ) value = ATTRS.includes(el.value) ? el.value : null;
    else if ( spec.kind === "count" ) value = cleanCount(el.value);
    else value = cleanText(el.value, spec.max);
    foundry.utils.setProperty(this.plan, el.name, value);
    await this.#changed({ render: picker || spec.render });
  }

  #applyFilter(input) {
    const list = this.element.querySelector(`[data-filter-list="${input.dataset.filter}"]`);
    if ( !list ) return;
    const query = input.value.trim().toLowerCase();
    this.filters[`search:${input.dataset.filter}`] = input.value;
    for ( const row of list.querySelectorAll("[data-search]") ) row.hidden = !!query && !row.dataset.search.includes(query);
  }

  #setLanguageFlag(name, flag, value) {
    if ( !["read", "write"].includes(flag) ) return;
    let entry = this.plan.languages.find(l => l.name.toLowerCase() === name.toLowerCase());
    if ( !entry ) this.plan.languages.push(entry = { uuid: null, name, read: false, write: false, auto: true });
    entry[flag] = value;
  }

  /** A background table's result, also written into the character field it belongs to (`TRAIT_FIELDS`). */
  #setTrait(label, text) {
    const entry = this.plan.bio.traits.find(t => t.label === label);
    if ( entry ) entry.text = text;
    else this.plan.bio.traits.push({ label, text });
    if ( TRAIT_FIELDS[label] ) foundry.utils.setProperty(this.plan, TRAIT_FIELDS[label], text);
  }

  /** Can another profession (or extra language) be added? Warns when not. */
  #mayAdd(kind) {
    const ok = kind === "language" ? this.allowance.canAddLanguage : this.allowance.canAddProfession;
    if ( !ok ) ui.notifications.warn(loc(kind === "language" ? "AVTTSB.Languages.Full" : "AVTTSB.Professions.Full"));
    return ok;
  }

  /* -------------------------------------------- */
  /*  Navigation and submitting                   */
  /* -------------------------------------------- */

  static async #onStep(event, target) {
    this.step = target.dataset.step;
    await this.#changed();
  }

  static #onNext() { return this.#move(1); }
  static #onBack() { return this.#move(-1); }

  /** Go to the next or previous step shown at the last render. */
  #move(by) {
    const i = this.stepIds.indexOf(this.step);
    this.step = this.stepIds[Math.clamp(i + by, 0, this.stepIds.length - 1)];
    return this.#changed();
  }

  static async #onRestart() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "AVTTSB.Restart.Title" }, content: `<p>${loc("AVTTSB.Restart.Content")}</p>`
    });
    if ( !ok ) return;
    this.plan = this.actor ? CharacterBuilder.levelUpPlan(this.actor) : newPlan(CharacterBuilder.defaultLevel());
    this.step = this.actor ? "paths" : "ancestry";
    this.kits = null;
    if ( !this.actor ) await game.user.unsetFlag(MODULE_ID, "draft").catch(() => null);
    await this.render();
  }

  /** Create the character, or apply the level up. */
  static async #onSubmit(event, target) {
    if ( this.missing.review ) return ui.notifications.warn(loc("AVTTSB.Create.Incomplete"));
    target.disabled = true;
    const actor = await this.#once(() => (this.actor ? levelUpCharacter(this.actor, this.plan) : createCharacter(this.plan)));
    if ( !actor ) {
      target.disabled = false;
      return;
    }
    if ( !this.actor ) await game.user.unsetFlag(MODULE_ID, "draft").catch(() => null);
    ui.notifications.info(fmt(this.actor ? "AVTTSB.LevelUp.Done" : "AVTTSB.Create.Done", { name: actor.name, level: this.plan.level }));
    await this.close();
    actor.sheet?.render({ force: true });
  }

  static async #onLoadKits() {
    ui.notifications.info(loc("AVTTSB.Equipment.Loading"));
    this.kits = await this.#once(loadEquipmentKits);
    if ( !this.kits ) ui.notifications.warn(loc("AVTTSB.Equipment.KitsMissing"));
    await this.render({ parts: ["body"] });
  }

  static async #onShowItem(event, target) {
    const doc = await fromUuid(target.dataset.uuid).catch(() => null);
    doc?.sheet?.render({ force: true });
  }

  static async #onPickImage() {
    await new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: this.plan.img,
      callback: path => {
        this.plan.img = path;
        this.#changed();
      }
    }).browse();
  }

  /* -------------------------------------------- */
  /*  Plan changes (wrapped by #edit)             */
  /* -------------------------------------------- */

  static async #onPickAncestry(event, target) {
    const uuid = target.dataset.uuid;
    if ( this.plan.ancestry.uuid === uuid ) return false;
    const sizes = sizeOptions(await getDoc(uuid));
    this.plan.ancestry = { ...newPlan().ancestry, uuid, size: sizes.length === 1 ? sizes[0] : null };
    // Ancestry languages are re-derived; keep only languages the player added.
    this.plan.languages = this.plan.languages.filter(l => !l.auto);
  }

  static #onPickPath(event, target) {
    const { tier, uuid } = target.dataset;
    if ( !this.plan.paths[tier] || (this.plan.paths[tier].uuid === uuid) ) return false;
    this.plan.paths[tier] = { uuid, choices: {} };
  }

  static #onToggleAttr(event, target) {
    const { tier, level, attr } = target.dataset;
    const choices = this.plan.paths[tier]?.choices;
    const lvl = newLevels(this.docs[tier], this.plan).find(l => levelKey(l) === level);
    if ( !choices || !lvl || !ATTRS.includes(attr) ) return false;
    const entry = choices[level] ??= { attrs: [], pick: null };
    if ( entry.attrs.includes(attr) ) entry.attrs = entry.attrs.filter(a => a !== attr);
    else if ( entry.attrs.length < attrChoiceCount(lvl) ) entry.attrs.push(attr);
  }

  static #onPickTalent(event, target) {
    const { tier, level, pick } = target.dataset;
    const choices = this.plan.paths[tier]?.choices;
    if ( !choices ) return false;
    const entry = choices[level] ??= { attrs: [], pick: null };
    entry.pick = entry.pick === pick ? null : pick;
  }

  /** Discover a tradition (its free rank 0 spell is chosen on its row). */
  static #onAddTradition() {
    const name = this.element.querySelector("select[name=addTradition]")?.value;
    if ( !name ) return false;
    if ( !this.magic.canAddTradition(name) ) {
      ui.notifications.warn(loc("AVTTSB.Magic.FullTraditions"));
      return false;
    }
    this.plan.traditions.push({ name, spell: null });
  }

  /** Forget a discovered tradition, with the spells learned from it. */
  static #onRemoveTradition(event, target) {
    const [removed] = this.plan.traditions.splice(Number(target.dataset.index), 1);
    if ( !removed ) return false;
    this.plan.spells = this.plan.spells.filter(u => this.index.byUuid.get(u)?.tradition !== removed.name);
  }

  static #onAddSpell(event, target) {
    const entry = this.index.byUuid.get(target.dataset.uuid);
    if ( (entry?.type !== "spell") || this.plan.spells.includes(entry.uuid) ) return false;
    if ( !this.magic.canAddSpell(entry) ) {
      ui.notifications.warn(loc("AVTTSB.Magic.FullSpells"));
      return false;
    }
    this.plan.spells.push(entry.uuid);
  }

  static #onAddProfession(event, target) {
    const entry = this.index.byUuid.get(target.dataset.uuid);
    if ( (entry?.type !== "profession") || this.plan.professions.some(p => p.uuid === entry.uuid) ) return false;
    if ( !this.#mayAdd("profession") ) return false;
    this.plan.professions.push({ uuid: entry.uuid, name: entry.name, text: "" });
  }

  static #onAddCustomProfession() {
    const name = cleanText(this.element.querySelector("input[name=customProfession]")?.value, LIMITS.name).trim();
    if ( !name || !this.#mayAdd("profession") ) return false;
    this.plan.professions.push({ uuid: null, name, text: "" });
  }

  static async #onRollProfession() {
    if ( !this.#mayAdd("profession") ) return false;
    const rolled = await this.#once(rollProfession);
    if ( !rolled ) {
      if ( rolled === null ) ui.notifications.warn(loc("AVTTSB.Professions.RollFailed"));
      return false;
    }
    const match = await findByName("profession", rolled.name);
    const name = match?.name ?? rolled.name;
    this.plan.professions.push({ uuid: match?.uuid ?? null, name, text: rolled.text });
    ui.notifications.info(fmt("AVTTSB.Professions.Rolled", { kind: rolled.kind, name }));
  }

  static #onAddLanguage() {
    const entry = this.index.byUuid.get(this.element.querySelector("select[name=addLanguage]")?.value);
    if ( (entry?.type !== "language") || this.plan.languages.some(l => l.name === entry.name) ) return false;
    if ( !this.#mayAdd("language") ) return false;
    this.plan.languages.push({ uuid: entry.uuid, name: entry.name, read: false, write: false, auto: false });
  }

  static #onRemoveAt(event, target) {
    const list = LISTS[target.dataset.list]?.(this.plan);
    if ( !list ) return false;
    list.splice(Number(target.dataset.index), 1);
  }

  static async #onRollTrait(event, target) {
    const table = await getDoc(target.dataset.uuid);
    const rolled = (table instanceof RollTable) && await this.#once(() => rollTable(table));
    if ( !rolled ) return false;
    this.#setTrait(target.dataset.label, rolled.text);
  }

  static async #onRollInteresting() {
    const table = await findTable("Interesting Things Tables");
    const rolled = table && await this.#once(() => rollTable(table));
    if ( !rolled ) return false;
    this.plan.bio.interesting = rolled.text;
  }

  static async #onRollWealth() {
    const result = await this.#once(rollWealth);
    if ( !result?.lifestyle ) {
      if ( result !== false ) ui.notifications.warn(loc("AVTTSB.Equipment.RollFailed"));
      return false;
    }
    this.plan.equipment.lifestyle = result.lifestyle;
    this.plan.equipment.wealthRoll = result.total;
  }

  static #onAddItem(event, target) {
    const entry = this.index.byUuid.get(target.dataset.uuid);
    if ( !entry ) return false;
    const owned = this.plan.equipment.items.find(i => i.uuid === entry.uuid);
    if ( owned ) owned.qty += 1;
    else this.plan.equipment.items.push({ uuid: entry.uuid, name: entry.name, img: entry.img, qty: 1 });
  }

  /** Roll the kit's purse ("a pouch containing 1d6 bits") and add it to the coins. */
  static async #onRollCoins() {
    const coins = this.kits?.[this.plan.equipment.lifestyle]?.coins;
    if ( !coins ) return false;
    await this.#addCoins(coins.formula, coins.coin);
  }

  /** "Equipment at Higher Levels": 2d6 ss per level. */
  static async #onRollLevelCoins() {
    if ( this.plan.level < 1 ) return false;
    await this.#addCoins(`${this.plan.level * 2}d6`, "ss");
  }

  async #addCoins(formula, coin) {
    const roll = await new Roll(formula).evaluate();
    const total = Math.max(0, roll.total);
    this.plan.equipment.coins[coin] = cleanCount(this.plan.equipment.coins[coin] + total);
    ui.notifications.info(fmt("AVTTSB.Equipment.CoinsRolled", { total, coin: loc(`AVTTSB.Coin.${coin}`) }));
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Castings per spell rank at a Power score (core book "Castings by Spell Rank"). */
const CASTINGS = [
  [1], [2, 1], [3, 2, 1], [4, 2, 1, 1], [5, 2, 2, 1, 1], [6, 3, 2, 2, 1, 1], [7, 3, 2, 2, 2, 1, 1],
  [8, 3, 2, 2, 2, 1, 1, 1], [9, 3, 3, 2, 2, 2, 1, 1, 1], [10, 3, 3, 3, 2, 2, 1, 1, 1, 1], [11, 3, 3, 3, 3, 2, 1, 1, 1, 1, 1]
];

/** A table's entries as `selectOptions` choices: `{ options: [{ value, label, group }], groups }`. */
function entryChoices(groups) {
  return {
    options: groups.flatMap(g => g.options.map(o => ({ value: o.text, label: `${o.range}: ${o.text}`, group: g.label || undefined }))),
    groups: groups.map(g => g.label).filter(Boolean)
  };
}

/** Guidance entries with their texts made readable (links resolved to names). */
function displayGuidance(entries) {
  return Promise.all(entries.map(async g => ({ ...g, text: await displayText(g.text) })));
}

/** "Strength +1, Health +5, …" from `[labelKey, value]` pairs (zeros left out). */
function bonusText(pairs) {
  return pairs.filter(([, n]) => Number(n)).map(([key, n]) => `${loc(key)} ${signed(n)}`).join(", ");
}

/** A level up's gains as text. */
function gainsText(gains) {
  return bonusText([...ATTRS.map(a => [`AVTTSB.Attr.${a}`, gains.scores[a]]),
    ...CHARACTERISTICS.map(k => [`AVTTSB.Char.${k}`, gains[k]])]);
}

/** "Human Age" → "Age" (the ancestry's tables are named after it). */
function traitLabel(tableName, ancestryName) {
  if ( ancestryName && tableName.startsWith(`${ancestryName} `) ) return tableName.slice(ancestryName.length + 1);
  return tableName;
}
