# ChemBuilder

A local app for drawing molecules and reaction schemes, with live property
calculation, scheme analysis and export. Everything runs on your machine:
no account, no network calls, no data leaves the box.

## Start it

Double-click **`ChemBuilder.cmd`**, or from a terminal:

```
npm start          # starts the server and opens your browser
node server.js     # starts the server only
```

The server binds to `127.0.0.1` on port 8731 (it walks up to 8740 if that
port is busy; set `CHEMBUILDER_PORT` to pin one). It has no dependencies, so
there is nothing to install beyond Node 18 or newer.

## What it does

**Drawing** is the Ketcher editor, embedded whole. Atoms, bonds, rings,
templates, stereo, charges, R-groups, text annotations, reaction arrows,
plus signs and reagents written over the arrow. Multi-step schemes work.

**Properties** update as you draw, computed by RDKit compiled to
WebAssembly:

| | |
|---|---|
| Identity | Hill formula, net charge, composition, InChI, InChIKey, canonical SMILES |
| Mass | molecular weight, monoisotopic mass |
| Drug-likeness | cLogP, TPSA, H-bond donors and acceptors, rotatable bonds, Lipinski and Veber verdicts |
| Shape | rings, aromatic rings, heteroatoms, stereocentres, fraction Csp3, molar refractivity, Labute ASA |

A half-drawn structure that RDKit cannot sanitize still reports its
composition, with a note saying the rest is unavailable.

**Reaction schemes** get their own panel: the reaction SMILES, a component
table split into reactants, products and reagents over the arrow, and a
per-element atom balance that tells you whether the scheme is balanced and
by how much it is off.

**Stoichiometry** sits under the component table. Pick a reactant, enter a
mass, set equivalents per component, and the table fills in mmol and mass
for everything. Enter the isolated mass of a product for a yield. A
multi-step scheme is analysed as its overall transformation.

**Exports**

- Text: SMILES, extended SMILES, SMARTS, MOL V2000 and V3000, SDF,
  RXN V2000 and V3000, CML, KET, InChI, InChIKey. Copy or save each one.
- Image: PNG and SVG at any width, with the drawing's own aspect kept and
  the height field acting as a cap. Optional transparent background.
  "Copy PNG" puts the image straight on the clipboard for pasting into
  slides or a document.

**Library.** Save a drawing and it lands in `drawings/` as three plain
files: a `.ket` with the structure, a `.json` with the metadata and an
`.svg` thumbnail. The sidebar lists them with search, duplicate and
delete; click an entry to open it. Nothing is in a database, so the
folder is yours to back up, diff or sync.

Unsaved work is kept in browser storage, so a refresh or an accidental
close does not lose the canvas. The app asks before it replaces an
unsaved canvas with a new or opened drawing, and the tab title shows a
dot while there are unsaved changes.

**Help.** The Help button in the top bar (or `F1`) opens a short guide
and the shortcut list.

## Keyboard

| Key | Action |
|---|---|
| `Ctrl` `S` | Save |
| `Ctrl` `Alt` `N` | New drawing |
| `Ctrl` `B` | Toggle the library |
| `Ctrl` `I` | Toggle the inspector |
| `F1` | Help and shortcuts |

The editor itself has its own shortcuts, listed under its help button.

## Layout

```
server.js        zero-dependency HTTP + JSON API, loopback only
app/             the shell: index.html, app.js, chem.js, app.css
vendor/ketcher   Ketcher 3.18.0 standalone build
vendor/rdkit     RDKit 2026.09.1 compiled to WebAssembly
drawings/        your saved work, one .ket + .json + .svg per drawing
```

`app/chem.js` is the only file that talks to RDKit. `app/app.js` owns the
editor bridge, the library and the export paths. Neither needs a build
step; edit and reload.

## Good to know

- **First load takes a few seconds.** The editor and the chemistry engine
  are about 37 MB together. They are cached immutably after that, so
  later loads are fast.
- **Reaction analysis reads the reaction SMILES**, so anything the editor
  cannot express in SMILES (free-text labels over an arrow, say) is not
  counted in the balance.
- **The balance checks atoms, not chemistry.** An unbalanced verdict
  usually means a reagent or by-product is missing from the drawing, which
  is exactly what it is there to catch.
- **Macromolecule mode** (the editor's own sequence/polymer view) has no
  SMILES or MOL representation, so the inspector panels will report that
  those formats are unavailable while it is on.
- **Clipboard image copy** needs the browser's clipboard permission and a
  recent Chrome, Edge or Firefox.
- **Attachment points** (the editor's `*` atom) show as `R` at the end of
  a formula and in the composition, and are not counted as heavy atoms.

## Licences

This project embeds two open-source libraries, unmodified:

- **Ketcher** by EPAM Systems, Apache License 2.0 — `vendor/ketcher/LICENSE.txt`
- **RDKit** by Greg Landrum and contributors, BSD 3-Clause — `vendor/rdkit/LICENSE.txt`

See `NOTICE.md`.
