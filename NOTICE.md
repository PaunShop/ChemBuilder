# Third-party notices

ChemBuild bundles the following open-source software, unmodified,
under `vendor/`. Each is redistributed under its own licence, and the full
licence text ships alongside it.

## Ketcher

- Version 3.18.0, standalone build (`vendor/ketcher/`)
- Copyright EPAM Systems
- Licence: Apache License 2.0 — full text in `vendor/ketcher/LICENSE.txt`
- Source: https://github.com/epam/ketcher

Provides the structure editor shown in the centre of the app, including
its bundled Indigo toolkit compiled to WebAssembly, which performs the
MOL, RXN, SDF, CML and SMILES conversions.

The build was taken from the official `ketcher-standalone-3.18.0.zip`
release asset. Unused entry bundles (`popup`, `duo`, `closable` and their
HTML and CSS) were deleted to cut the install size; no file was edited.

## RDKit

- Version 2026.09.1, `RDKit_minimal` WebAssembly build (`vendor/rdkit/`)
- Copyright 2006-2015 Rational Discovery LLC, Greg Landrum, Julie Penzotti
  and others; and contributors thereafter
- Licence: BSD 3-Clause — full text in `vendor/rdkit/LICENSE.txt`
- Source: https://github.com/rdkit/rdkit, distributed as the npm package
  `@rdkit/rdkit`

Provides every computed property in the inspector: formula, masses,
cLogP, TPSA, the Lipinski and Veber descriptors, InChI and InChIKey
generation, the reaction component analysis and the library thumbnails.

## Everything else

`server.js`, `app/` and the documentation are part of this project and
carry no third-party claims.
