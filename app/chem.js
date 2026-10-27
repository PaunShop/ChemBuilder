/*
 * chem.js - chemistry services for ChemBuild.
 * Wraps RDKit.js (WASM) with helpers for molecule properties,
 * reaction-scheme decomposition and element balance.
 * Everything runs locally in the browser.
 */
(function (global) {
  'use strict';

  var SYMBOLS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn ' +
    'Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm ' +
    'Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu ' +
    'Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');

  function symbolFor(z) {
    return SYMBOLS[z - 1] || ('Z' + z);
  }

  var RDKit = null;
  var readyPromise = null;

  function load() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (!global.initRDKitModule) {
        reject(new Error('RDKit loader script missing'));
        return;
      }
      global
        .initRDKitModule({ locateFile: function () { return '/vendor/rdkit/RDKit_minimal.wasm'; } })
        .then(function (mod) {
          RDKit = mod;
          resolve(mod);
        })
        .catch(reject);
    });
    return readyPromise;
  }

  function isReady() {
    return !!RDKit;
  }

  function version() {
    return RDKit ? RDKit.version() : null;
  }

  /* Parse, run fn, always free the WASM handle. */
  function withMol(input, details, fn) {
    var mol = null;
    try {
      mol = details ? RDKit.get_mol(input, JSON.stringify(details)) : RDKit.get_mol(input);
    } catch (err) {
      mol = null;
    }
    if (!mol) return null;
    try {
      if (typeof mol.is_valid === 'function' && !mol.is_valid()) return null;
      return fn(mol);
    } finally {
      try { mol.delete(); } catch (err) { /* already freed */ }
    }
  }

  /* Element counts and net charge straight from RDKit's CommonChem JSON. */
  function atomTally(mol) {
    var doc = JSON.parse(mol.get_json());
    var defaults = (doc.defaults && doc.defaults.atom) || {};
    var defZ = defaults.z != null ? defaults.z : 6;
    var defImp = defaults.impHs != null ? defaults.impHs : 0;
    var defChg = defaults.chg != null ? defaults.chg : 0;
    var counts = {};
    var charge = 0;
    var heavy = 0;
    var mols = doc.molecules || [];
    for (var m = 0; m < mols.length; m++) {
      var atoms = mols[m].atoms || [];
      for (var i = 0; i < atoms.length; i++) {
        var a = atoms[i];
        var z = a.z != null ? a.z : defZ;
        var imp = a.impHs != null ? a.impHs : defImp;
        var chg = a.chg != null ? a.chg : defChg;
        var sym = symbolFor(z);
        counts[sym] = (counts[sym] || 0) + 1;
        if (z !== 1) heavy++;
        if (imp) counts.H = (counts.H || 0) + imp;
        charge += chg;
      }
    }
    return { counts: counts, charge: charge, heavy: heavy };
  }

  /* Hill notation: C first, then H, then the rest alphabetically. */
  function hillFormula(counts, charge) {
    var keys = Object.keys(counts).filter(function (k) { return counts[k] > 0; });
    var rest = keys.filter(function (k) { return k !== 'C' && k !== 'H'; }).sort();
    var order = [];
    if (counts.C) order.push('C');
    if (counts.H) order.push('H');
    order = order.concat(rest);
    var out = order
      .map(function (k) { return k + (counts[k] > 1 ? String(counts[k]) : ''); })
      .join('');
    if (charge) {
      var mag = Math.abs(charge);
      out += (mag > 1 ? String(mag) : '') + (charge > 0 ? '+' : '-');
    }
    return out || '-';
  }

  function formulaFromInchi(inchi) {
    if (!inchi || inchi.indexOf('InChI=') !== 0) return '';
    var parts = inchi.split('/');
    return parts.length > 1 ? parts[1] : '';
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /*
   * Full property read-out for one structure (SMILES, molblock or rxn-free input).
   * Falls back to an unsanitized parse so half-finished drawings still report a formula.
   */
  function molInfo(input) {
    if (!RDKit) return { ok: false, error: 'Chemistry engine still loading' };
    if (!input || !String(input).trim()) return { ok: false, empty: true };

    var full = withMol(input, null, function (mol) {
      var d = {};
      try { d = JSON.parse(mol.get_descriptors()); } catch (err) { d = {}; }
      var tally = atomTally(mol);
      var inchi = '';
      var inchikey = '';
      try { inchi = mol.get_inchi(); } catch (err) { inchi = ''; }
      try { inchikey = inchi ? RDKit.get_inchikey_for_inchi(inchi) : ''; } catch (err) { inchikey = ''; }
      var formula = hillFormula(tally.counts, tally.charge);
      if (!formula || formula === '-') formula = formulaFromInchi(inchi);
      var mw = num(d.amw);
      var clogp = num(d.CrippenClogP);
      var tpsa = num(d.tpsa);
      var hbd = num(d.lipinskiHBD != null ? d.lipinskiHBD : d.NumHBD);
      var hba = num(d.lipinskiHBA != null ? d.lipinskiHBA : d.NumHBA);
      var rotb = num(d.NumRotatableBonds);
      var smiles = '';
      var smarts = '';
      try { smiles = mol.get_smiles(); } catch (err) { smiles = ''; }
      try { smarts = mol.get_smarts(); } catch (err) { smarts = ''; }

      var lipinskiFails = 0;
      if (mw != null && mw > 500) lipinskiFails++;
      if (clogp != null && clogp > 5) lipinskiFails++;
      if (hbd != null && hbd > 5) lipinskiFails++;
      if (hba != null && hba > 10) lipinskiFails++;
      var veberOk = (rotb == null || rotb <= 10) && (tpsa == null || tpsa <= 140);

      return {
        ok: true,
        partial: false,
        smiles: smiles,
        smarts: smarts,
        formula: formula,
        charge: tally.charge,
        elements: tally.counts,
        heavyAtoms: tally.heavy,
        mw: mw,
        exactMass: num(d.exactmw),
        clogp: clogp,
        tpsa: tpsa,
        hbd: hbd,
        hba: hba,
        rotb: rotb,
        rings: num(d.NumRings),
        aromaticRings: num(d.NumAromaticRings),
        heterocycles: num(d.NumHeterocycles),
        stereocenters: num(d.NumAtomStereoCenters),
        unspecifiedStereo: num(d.NumUnspecifiedAtomStereoCenters),
        fsp3: num(d.FractionCSP3),
        heteroatoms: num(d.NumHeteroatoms),
        amides: num(d.NumAmideBonds),
        bridgeheads: num(d.NumBridgeheadAtoms),
        spiro: num(d.NumSpiroAtoms),
        mr: num(d.CrippenMR),
        labuteASA: num(d.labuteASA),
        inchi: inchi,
        inchikey: inchikey,
        lipinskiFails: lipinskiFails,
        lipinskiPass: lipinskiFails <= 1,
        veberPass: veberOk,
      };
    });
    if (full) return full;

    /* Sanitization failed - still try to describe what was drawn. */
    var loose = withMol(input, { sanitize: false, kekulize: false }, function (mol) {
      var tally = atomTally(mol);
      var smi = '';
      try { smi = mol.get_smiles(); } catch (err) { smi = ''; }
      return {
        ok: true,
        partial: true,
        reason: 'RDKit could not sanitize this structure, so only composition is shown.',
        smiles: smi,
        formula: hillFormula(tally.counts, tally.charge),
        charge: tally.charge,
        elements: tally.counts,
        heavyAtoms: tally.heavy,
      };
    });
    if (loose) return loose;
    return { ok: false, error: 'Structure could not be parsed' };
  }

  /* Split "A.B" into components without breaking brackets or branches. */
  function splitComponents(smiles) {
    var out = [];
    var depth = 0;
    var bracket = 0;
    var cur = '';
    var s = String(smiles || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === '.' && depth === 0 && bracket === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /* Reaction SMILES is reactants > agents > products. Ketcher may omit the agent field. */
  function parseReactionSmiles(rxn) {
    var s = String(rxn || '').trim();
    if (!s) return null;
    var fields = s.split('>');
    if (fields.length < 2) return null;
    /*
     * Two fields is reactants>>products. Three is the classic reactants>agents>products.
     * More than three means a multi-step scheme: report the overall transformation
     * (first inputs to final products) and treat everything between as agents.
     */
    var reactants = fields[0];
    var products = fields[fields.length - 1];
    var agents = fields.length > 2 ? fields.slice(1, -1).join('.') : '';
    return {
      reactants: splitComponents(reactants),
      agents: splitComponents(agents),
      products: splitComponents(products),
      multiStep: fields.length > 3,
    };
  }

  function sumMass(infos) {
    var total = 0;
    var complete = true;
    for (var i = 0; i < infos.length; i++) {
      if (infos[i] && infos[i].mw != null) total += infos[i].mw;
      else complete = false;
    }
    return { total: total, complete: complete };
  }

  /* Per-element comparison of the left and right sides of a scheme. */
  function elementBalance(reactantInfos, productInfos) {
    var left = {};
    var right = {};
    var i;
    var k;
    function add(target, info) {
      if (!info || !info.elements) return false;
      var els = info.elements;
      var keys = Object.keys(els);
      for (var j = 0; j < keys.length; j++) {
        target[keys[j]] = (target[keys[j]] || 0) + els[keys[j]];
      }
      return true;
    }
    var known = true;
    for (i = 0; i < reactantInfos.length; i++) if (!add(left, reactantInfos[i])) known = false;
    for (i = 0; i < productInfos.length; i++) if (!add(right, productInfos[i])) known = false;

    var seen = {};
    var keys = Object.keys(left).concat(Object.keys(right));
    var rows = [];
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (seen[k]) continue;
      seen[k] = true;
      var l = left[k] || 0;
      var r = right[k] || 0;
      rows.push({ element: k, left: l, right: r, delta: r - l });
    }
    rows.sort(function (a, b) {
      if (a.element === 'C') return -1;
      if (b.element === 'C') return 1;
      if (a.element === 'H') return -1;
      if (b.element === 'H') return 1;
      return a.element.localeCompare(b.element);
    });
    var balanced = known && rows.every(function (row) { return row.delta === 0; });
    var lm = sumMass(reactantInfos);
    var rm = sumMass(productInfos);
    return {
      rows: rows,
      balanced: balanced,
      known: known,
      massLeft: lm.total,
      massRight: rm.total,
      massComplete: lm.complete && rm.complete,
    };
  }

  /* Analyse a whole canvas: either one molecule or a full reaction scheme. */
  function analyze(structure) {
    var text = String(structure || '').trim();
    if (!text) return { kind: 'empty' };
    if (text.indexOf('>') !== -1) {
      var parsed = parseReactionSmiles(text);
      if (parsed) {
        var mapRole = function (list) {
          return list.map(function (smi) {
            var info = molInfo(smi);
            info.input = smi;
            return info;
          });
        };
        var reactants = mapRole(parsed.reactants);
        var agents = mapRole(parsed.agents);
        var products = mapRole(parsed.products);
        return {
          kind: 'reaction',
          reactionSmiles: text,
          reactants: reactants,
          agents: agents,
          products: products,
          multiStep: !!parsed.multiStep,
          balance: elementBalance(reactants, products),
        };
      }
    }
    var info = molInfo(text);
    info.kind = 'molecule';
    info.input = text;
    return info;
  }

  /* Stoichiometry for a scheme: scale everything off one limiting reactant. */
  function stoichiometry(opts) {
    var limitingMw = num(opts.limitingMw);
    var limitingMassMg = num(opts.limitingMassMg);
    var equiv = num(opts.equiv) || 1;
    if (limitingMw == null || limitingMw <= 0 || limitingMassMg == null) return null;
    var mmol = limitingMassMg / limitingMw / equiv;
    return {
      mmol: mmol,
      forComponent: function (mw, eq) {
        var e = num(eq) || 1;
        if (mw == null) return null;
        return { mmol: mmol * e, massMg: mmol * e * mw };
      },
    };
  }

  function svgFor(input, width, height) {
    if (!RDKit || !input) return '';
    var rxn = String(input).indexOf('>') !== -1;
    if (rxn && typeof RDKit.get_rxn === 'function') {
      var r = null;
      try { r = RDKit.get_rxn(input); } catch (err) { r = null; }
      if (r) {
        try { return r.get_svg(width || 600, height || 240); } finally { try { r.delete(); } catch (e) { /* freed */ } }
      }
      return '';
    }
    return withMol(input, null, function (mol) {
      return mol.get_svg(width || 420, height || 300);
    }) || '';
  }

  global.Chem = {
    load: load,
    isReady: isReady,
    version: version,
    analyze: analyze,
    molInfo: molInfo,
    splitComponents: splitComponents,
    parseReactionSmiles: parseReactionSmiles,
    elementBalance: elementBalance,
    hillFormula: hillFormula,
    stoichiometry: stoichiometry,
    svgFor: svgFor,
    symbolFor: symbolFor,
  };
})(window);
