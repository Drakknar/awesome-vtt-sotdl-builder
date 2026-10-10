# Awesome VTT – Demon Lord Character Builder

A guided character builder for **Shadow of the Demon Lord** on Foundry VTT v14 (`demonlord` system 6.1.x). One window walks you through the steps, inspired by Hero Mancer's dnd5e wizard:

1. **Ancestry**: pick an ancestry, its size if there's a choice, and see its talents, languages and level-4 benefit.
2. **Attributes**: starting scores, the ancestry's choice where it has one, and the once-only +1/−1 adjustment.
3. **Paths** (starting level 1+): novice, expert and master paths with each level's attribute increases and talent choices, plus the ancestry's level-4 choice (talent or spell).
4. **Magic**: spells by tradition, up to your Power's rank, with your paths' instructions shown alongside.
5. **Professions & Languages**: choose or roll professions. Add languages and mark which ones you can read or write. You get two professions, plus any your ancestry and paths grant at your level. Extra languages use the same allowance, because the book lets you trade a profession for a language.
6. **Background**: name, portrait, your ancestry's tables (age, build, background, personality, religion…), an interesting thing, and appearance.
7. **Equipment**: roll wealth for your lifestyle, add your lifestyle's starting kit and purse from the rulebook, and browse other gear.
8. **Review**, then **Create**.

**Level up** an existing character with the same window: choose **Level Up** in the character sheet's header menu, or right-click the character in the Actors sidebar. It shows only what the new levels need: each level's attribute increases and talent choices, a new path at levels 1, 3 and 7, the ancestry's level-4 choice, spells, and any professions or languages the new levels grant. The system then adds the new talents and effects.

A sidebar previews scores, Health, Defense, Perception, Speed, Size, Power and Insanity as you choose. Your progress is saved as a draft.

## Requirements
- The `demonlord` system, and compendiums with the game content. The system itself has no ancestries, paths, talents or spells. The core book's compendium module (`sdlc-1000`) is supported. Any Item compendium or world item with the right types is offered too.
- This module includes no game content.

## Use
- Click **Build Character** at the top of the Actors sidebar.
- Players who don't have the "Create new actors" permission can still finish a build. A logged-in GM's client creates the character and gives that player ownership.
- Macro or other modules: `game.modules.get("awesome-vtt-sotdl-builder").api.open()`.

## Settings (world)
- **Starting level** (0–10, default 0) and **Players choose the level**.
- **Players may create characters** (through the GM, see above).
- **Assign as the player's character**.
- **Starting equipment page**: the journal page with the lifestyle kits (the core book's by default).

## Limits
- Traditions and spells follow your paths' grants for the levels you gain (for example Magician 1: one tradition, then three choices). A tradition associated with your religion can be any tradition, because the compendium doesn't link religions to traditions.
- Results from background tables, such as Insanity, Corruption or extra coins, aren't applied automatically. Apply them on the sheet.

Independent of the other Awesome VTT modules; it doesn't need `awesome-vtt-core`.
