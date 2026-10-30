/**
 * Awesome VTT – Demon Lord Character Builder: a guided character creation window for Shadow of the Demon Lord
 * (demonlord system), modelled on Hero Mancer's dnd5e wizard. See README.md.
 */

import { LEVELS, LIMITS, MODULE_ID } from "./constants.mjs";
import CharacterBuilder from "./builder.mjs";
import { clearContent } from "./content.mjs";
import { registerSocket } from "./create.mjs";

const CORE_EQUIPMENT_PAGE = "Compendium.sdlc-1000.journals.JournalEntry.S9Mh1N7l9KUNjPuh.JournalEntryPage.olyUdsrgbEU6CXIB";

const warn = key => ui.notifications.warn(game.i18n.localize(key));

/**
 * Open a builder window (or bring the open one to the front).
 * @param {string} id
 * @param {object} options
 * @returns {unknown}
 */
function show(id, options) {
  const existing = foundry.applications.instances.get(id);
  if ( existing ) return existing.bringToFront();
  return new CharacterBuilder(options).render({ force: true });
}

/**
 * Open the builder for a new character.
 * @param {object} root0
 * @param {string|undefined} root0.name
 * @returns {unknown}
 */
function open({ name } = {}) {
  if ( game.system.id !== "demonlord" ) return warn("AVTTSB.WrongSystem");
  if ( !game.user.isGM && !game.user.can("ACTOR_CREATE") && !game.settings.get(MODULE_ID, "playersMayCreate") ) {
    return warn("AVTTSB.Create.Error.NotAllowed");
  }
  return show(`${MODULE_ID}-builder`, { name });
}

/**
 * Can the current user level this actor up with the builder?
 * @param {Actor|null} actor
 * @returns {boolean}
 */
const canLevelUp = actor => (game.system.id === "demonlord") && (actor?.type === "character") && actor.isOwner
  && ((Number(actor.system.level) || 0) < LIMITS.level);

/**
 * Open the builder to level a character up.
 * @param {Actor|null} actor
 * @returns {unknown}
 */
function openLevelUp(actor) {
  if ( !canLevelUp(actor) ) return warn("AVTTSB.LevelUp.Error.NotOwner");
  return show(CharacterBuilder.levelUpId(actor), { actor });
}

/**
 * Register the builder's world settings.
 */
function registerSettings() {
  const reRender = () => foundry.applications.instances.get(`${MODULE_ID}-builder`)?.render();
  game.settings.register(MODULE_ID, "startLevel", {
    name: "AVTTSB.Settings.StartLevel.Name",
    hint: "AVTTSB.Settings.StartLevel.Hint",
    scope: "world", config: true, type: Number, default: 0,
    choices: Object.fromEntries(LEVELS.map(n => [n, String(n)])),
    onChange: reRender
  });
  game.settings.register(MODULE_ID, "playersChooseLevel", {
    name: "AVTTSB.Settings.PlayersChooseLevel.Name",
    hint: "AVTTSB.Settings.PlayersChooseLevel.Hint",
    scope: "world", config: true, type: Boolean, default: false, onChange: reRender
  });
  game.settings.register(MODULE_ID, "playersMayCreate", {
    name: "AVTTSB.Settings.PlayersMayCreate.Name",
    hint: "AVTTSB.Settings.PlayersMayCreate.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "assignCharacter", {
    name: "AVTTSB.Settings.AssignCharacter.Name",
    hint: "AVTTSB.Settings.AssignCharacter.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "equipmentPage", {
    name: "AVTTSB.Settings.EquipmentPage.Name",
    hint: "AVTTSB.Settings.EquipmentPage.Hint",
    scope: "world", config: true, type: String, default: CORE_EQUIPMENT_PAGE
  });
}

/**
 * A launch button in the Actors directory header (as Hero Mancer does).
 * @param {ApplicationV2} app
 * @param {HTMLElement|object} element
 */
function injectLaunchButton(app, element) {
  if ( game.system.id !== "demonlord" ) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const actions = root?.querySelector("header.directory-header .header-actions");
  if ( !actions || actions.querySelector("[data-avtsb-launch]") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.avtsbLaunch = "";
  button.classList.add("avtsb-launch");
  button.innerHTML = `<i class="fa-solid fa-skull" inert></i> ${game.i18n.localize("AVTTSB.Launch")}`;
  button.addEventListener("click", () => open());
  actions.append(button);
}

Hooks.once("init", () => {
  registerSettings();
  foundry.applications.handlebars.loadTemplates(CharacterBuilder.PARTIALS);
  game.modules.get(MODULE_ID).api = { open, openLevelUp, CharacterBuilder };
});

Hooks.once("ready", () => {
  if ( game.system.id !== "demonlord" ) return;
  registerSocket();
});

Hooks.on("renderActorDirectory", injectLaunchButton);

// Level Up: in the character sheet's header menu and the Actors directory's context menu.
Hooks.on("getHeaderControlsActorSheetV2", (sheet, controls) => {
  if ( !canLevelUp(sheet.document) ) return;
  controls.push({ icon: "fa-solid fa-arrow-up-right-dots", label: "AVTTSB.LevelUp.Launch", onClick: () => openLevelUp(sheet.document) });
});
Hooks.on("getActorContextOptions", (app, options) => {
  options.push({
    label: "AVTTSB.LevelUp.Launch",
    icon: "fa-solid fa-arrow-up-right-dots",
    visible: li => canLevelUp(game.actors.get(li.dataset.entryId)),
    onClick: (event, li) => openLevelUp(game.actors.get(li.dataset.entryId))
  });
});

// Offered content changes when world items change (compendium changes need a reload, as for the system's browser).
for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
  Hooks.on(hook, doc => {
    if ( !doc.parent ) clearContent();
  });
}
