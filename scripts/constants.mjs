/**
 * Part of awesome-vtt-sotdl-builder: shared names and limits.
 */

export const MODULE_ID = "awesome-vtt-sotdl-builder";
export const CHANNEL = `module.${MODULE_ID}`;

/** The four attributes an ancestry or path can change (Perception follows Intellect). */
export const ATTRS = ["strength", "agility", "intellect", "will"];

/** Characteristics a level can raise (`level.characteristics`), in display order. */
export const CHARACTERISTICS = ["health", "power", "defense", "perception", "speed", "healingRate"];

/**
 * Wizard steps, in order. `createOnly` steps aren't part of a level up; `when(plan, { stats, magic })` hides a step
 * that doesn't apply to the build.
 */
export const STEPS = [
  { id: "ancestry", icon: "fa-solid fa-dna", createOnly: true },
  { id: "attributes", icon: "fa-solid fa-hand-fist", createOnly: true },
  { id: "paths", icon: "fa-solid fa-route", when: plan => plan.level >= 1 },
  // Only when the gained levels grant traditions or spells, or some were chosen.
  { id: "magic", icon: "fa-solid fa-wand-sparkles",
    when: (plan, { magic }) => (magic.grants > 0) || (plan.traditions.length > 0) || (plan.spells.length > 0) },
  { id: "professions", icon: "fa-solid fa-briefcase" },
  { id: "background", icon: "fa-solid fa-feather", createOnly: true },
  { id: "equipment", icon: "fa-solid fa-sack", createOnly: true },
  { id: "review", icon: "fa-solid fa-scroll" }
];

/** Background tables whose result also fills a character field (by the table's name without the ancestry). */
export const TRAIT_FIELDS = { Religion: "bio.religion", Age: "bio.appearance.age" };

/** Path tiers and the level at which each is chosen (Advancement table). */
export const TIERS = [
  { id: "novice", from: 1 },
  { id: "expert", from: 3 },
  { id: "master", from: 7 }
];

/** Appearance fields on the character (system.appearance). */
export const APPEARANCE = ["age", "sex", "eyes", "hair", "height", "weight", "feature"];

/** Coin fields on the character (system.wealth), smallest first. */
export const COINS = ["bits", "cp", "ss", "gc"];

/** Item types a player may bring in as equipment. */
export const EQUIPMENT_TYPES = ["weapon", "armor", "ammo", "item"];

/** Item types the builder may put on a character (checked again on the GM's side). */
export const ALLOWED_TYPES = new Set(["ancestry", "path", "talent", "spell", "profession", "language", ...EQUIPMENT_TYPES]);

/** Limits for a build plan sent to the GM (keeps a crafted message small and harmless). */
export const LIMITS = { name: 120, text: 4000, list: 60, items: 120, coins: 100000, level: 10 };

/** Starting levels the builder offers. */
export const LEVELS = Array.from({ length: LIMITS.level + 1 }, (_, i) => i);

/** Lifestyles of the Wealth table, in the book's order. */
export const LIFESTYLES = ["Destitute", "Poor", "Getting By", "Comfortable", "Wealthy", "Rich"];
