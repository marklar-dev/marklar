# Marklar

**Living specs in plain Markdown: live formulas, data tables and branching scenarios in a single source of truth.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Editor](https://img.shields.io/badge/editor-marklar.app-black)](https://marklar.app)

Marklar weaves linked actions and rules directly into Markdown. A Marklar file is always a regular `.md` file built on [GitHub Flavored Markdown](https://github.github.com/gfm/): headings, paragraphs, lists and tables. The extension adds meaning to these elements without replacing the format. It works with Git, diffs and code review, and AI assistants and parsers already understand it.

**Try it online: [marklar.app](https://marklar.app)**

## Why Marklar

The design document should be the single source of truth for the entire project. Describe data, conditions, logic and user flows in one readable document, then export, process and integrate it into software. No spreadsheets, separate data files or dedicated scenario editors.

- **One document, one source of truth.** JSON, XML, YAML and scenario scripts are generated from the document, not maintained separately.
- **A table is a ready-made class definition.** Rows are instances, the first column is the ID, the remaining columns are properties. Formulas are calculated live.
- **Minimal additions.** Headings define the scenario hierarchy and variable scope, bullet points are choices.
- **Clean text.** Everything stays readable outside of a dedicated editor.
- **Minimal syntax.** No loops, functions, nesting, braces or recursion. This is a tool for living specifications, not a programming language.

## A quick look

### Tables as data

The first cell is the class name, each row is an object, columns are properties. Formulas start with `=`.

```markdown
baseHealth = 100

| NPC      | Speed         | Health modifier | Health                          | Damage |
| -------- | ------------: | --------------: | ------------------------------: | -----: |
| Zombie   | 10            | 0.2             | =baseHealth*this.HealthModifier | 10     |
| Warrior  | 20            | 1.0             | =baseHealth*this.HealthModifier | 100    |
| Skeleton | =zombie.speed | 0.5             | =baseHealth*this.HealthModifier | 30     |
```

Data is addressable from anywhere in the document as `Table.Object.Property`, e.g. `NPC.Warrior.Health`.

### Formulas in text

```markdown
health = NPC.Warrior.Health
damage = 100
outcomeHealth = round(health - max(1, damage - 5))

Remaining health: %outcomeHealth%
```

### Scenarios

Headings are scenario nodes, bullets are choices, `?` is a condition, `->` is a transition and `::` writes to the dialogue log.

```markdown
## -> Bar
?  (!count)
money = 5
You suddenly find yourself in a bar. The bartender is polishing glasses.
?  else
You're still in the bar. You've got $%money% in your pocket.

? (money)
+ Order a beer. :: The bartender pours you a beer.
money--
-> Bar

+ Leave -> Exit

### Exit
:: You leave the bar. The end.
```

## Features

- Live formulas and variables inside plain text (`%variable%`, `%=expression%`)
- Tables compiled into an object model with spreadsheet-style and object-style addressing
- Scenario markup: nodes, conditions, transitions, one-time and permanent choices, random text variants
- Local variable scopes that follow the document hierarchy
- Import of objects from other files
- Export to compact JSON: one file for scenarios, one file per table, all text extracted into localization tables
- Standard Markdown extensions: callouts, wiki-links, KaTeX, Mermaid

## Repository contents

| Path            | What's inside                                                       |
| --------------- | ------------------------------------------------------------------- |
| `core/`         | Source of the core: parser, interpreter and exporter                |
| `docs/`         | Documentation and the full markup specification                     |
| `integrations/` | Integration libraries for playing exported scenarios in your apps * |
* In progress, not ready yet

> Adjust the paths above to match the actual layout of the repository.

## Documentation

The formal reference covers syntax, operators, naming and addressing rules, table semantics and the order of execution. See [`docs/`](docs/) or the *Full Markup Specification* section in the welcome document.

## Editor

The online editor at **[marklar.app](https://marklar.app)** lets you edit documents with live calculation, run and debug scenarios, and switch to a visual block mode. It is **not** part of this repository and is not open source. It is free to use for personal, non-commercial purposes; see the terms on the website.

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first to discuss what you would like to change.

## License

The source code, documentation and integration libraries in this repository are released under the [MIT License](LICENSE).

The Marklar online editor is distributed separately under its own terms and is not covered by this license.

## Author

Created by **Andrey Sharapov**.
