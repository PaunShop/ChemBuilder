/*
 * app.js - ChemBuild shell.
 * Owns the Ketcher iframe bridge, the saved-drawing library,
 * the property/reaction inspector and all export paths.
 */
(function () {
  'use strict';

  var DRAFT_KEY = 'chembuild.draft.v1';
  var PANEL_KEY = 'chembuild.panels.v1';

  var state = {
    ketcher: null,
    id: null,
    name: '',
    dirty: false,
    structure: '', // last reaction/molecule SMILES read from the canvas
    analysis: null,
    equivs: {}, // component key -> equivalents
    saving: false,
  };

  var el = {};
  var ids = [
    'name', 'btn-save', 'btn-new', 'dirty', 'engine', 'btn-lib', 'btn-insp', 'layout',
    'library-list', 'lib-search', 'lib-count', 'lib-path', 'ketcher', 'canvas-veil',
    'kind-chip', 'partial-note', 'formula', 'mw', 'exact', 'rule-badges', 'prop-grid',
    'elements-box', 'elements-list', 'btn-refresh',
    'rxn-chip', 'rxn-smiles', 'rxn-components', 'balance-table', 'balance-verdict',
    'mass-balance', 'stoich-ref', 'stoich-mass', 'yield-ref', 'yield-mass', 'yield-out',
    'formats-list', 'btn-formats-refresh',
    'img-width', 'img-height', 'img-transparent', 'btn-png', 'btn-svg', 'btn-copy-png',
    'btn-preview', 'img-preview', 'toasts', 'offline-bar', 'btn-retry',
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    for (var i = 0; i < ids.length; i++) el[ids[i]] = $(ids[i]);
  }

  /* ---------- small helpers ---------- */

  function toast(msg, bad) {
    var node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    node.textContent = msg;
    el.toasts.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, bad ? 5000 : 2600);
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    if (typeof v !== 'number') return String(v);
    var d = digits === undefined ? 2 : digits;
    return v.toFixed(d);
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* Render a formula with subscripted digits, without using innerHTML. */
  function renderFormula(target, formula) {
    clearNode(target);
    var text = String(formula || '—');
    var buf = '';
    var flush = function () {
      if (buf) {
        target.appendChild(document.createTextNode(buf));
        buf = '';
      }
    };
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch >= '0' && ch <= '9') {
        var run = ch;
        while (i + 1 < text.length && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9') {
          run += text.charAt(++i);
        }
        flush();
        var sub = document.createElement('sub');
        sub.textContent = run;
        target.appendChild(sub);
      } else {
        buf += ch;
      }
    }
    flush();
  }

  function copyText(text, label) {
    if (!text) {
      toast('Nothing to copy', true);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast((label || 'Text') + ' copied'); },
        function () { toast('Clipboard blocked by the browser', true); }
      );
    } else {
      toast('Clipboard unavailable', true);
    }
  }

  function download(filename, data, mime) {
    var blob = data && typeof data === 'object' && typeof data.arrayBuffer === 'function'
      ? data
      : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function slug(text) {
    return (String(text || 'drawing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drawing').slice(0, 60);
  }

  function setDirty(flag) {
    state.dirty = !!flag;
    el.dirty.hidden = !flag;
    if (flag) saveDraft();
  }

  /* ---------- draft persistence (survives a refresh) ---------- */

  function saveDraft() {
    var ket = state.lastKet || '';
    /* beforeunload can fire before the canvas has been read back. An empty draft
       restores nothing, so never let one overwrite a usable draft. */
    if (!ket) {
      var prev = readDraft();
      if (prev && prev.ket) return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        id: state.id,
        name: el.name.value,
        structure: state.structure,
        ket: ket,
        at: Date.now(),
      }));
    } catch (err) { /* storage unavailable */ }
  }

  function readDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
  }

  /* ---------- Ketcher bridge ---------- */

  function ketcherWindow() {
    try {
      return el.ketcher.contentWindow;
    } catch (err) {
      return null;
    }
  }

  function waitForKetcher() {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var tick = function () {
        var win = ketcherWindow();
        if (win && win.ketcher && win.ketcher.editor) {
          resolve(win.ketcher);
          return;
        }
        waited += 150;
        if (waited > 45000) {
          reject(new Error('Editor did not start'));
          return;
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  var recomputeTimer = null;
  function scheduleRecompute(delay) {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(function () {
      recomputeTimer = null;
      refreshAnalysis();
    }, delay === undefined ? 350 : delay);
  }

  function hookChangeEvents(ketcher) {
    var hooked = false;
    try {
      if (ketcher.editor && typeof ketcher.editor.subscribe === 'function') {
        ketcher.editor.subscribe('change', function () {
          setDirty(true);
          scheduleRecompute();
        });
        hooked = true;
      }
    } catch (err) {
      hooked = false;
    }
    /* Safety net: poll in case the editor's event bus changes shape. */
    setInterval(function () {
      readStructure().then(function (smiles) {
        if (smiles !== state.structure) {
          if (!hooked) setDirty(true);
          renderAll(smiles);
        }
      });
    }, hooked ? 4000 : 1500);
  }

  async function readStructure() {
    var k = state.ketcher;
    if (!k) return '';
    try {
      var smiles = await k.getSmiles();
      return typeof smiles === 'string' ? smiles.trim() : '';
    } catch (err) {
      return '';
    }
  }

  async function readKet() {
    var k = state.ketcher;
    if (!k) return '';
    try {
      var ket = await k.getKet();
      return typeof ket === 'string' ? ket : '';
    } catch (err) {
      return '';
    }
  }

  function canvasIsReaction() {
    try {
      return !!(state.ketcher && state.ketcher.containsReaction());
    } catch (err) {
      return state.structure.indexOf('>') !== -1;
    }
  }

  /* ---------- analysis rendering ---------- */

  async function refreshAnalysis() {
    var smiles = await readStructure();
    renderAll(smiles);
  }

  function renderAll(smiles) {
    state.structure = smiles;
    state.lastKet = null;
    readKet().then(function (ket) { state.lastKet = ket; });

    if (!window.Chem || !Chem.isReady()) {
      el['kind-chip'].textContent = smiles ? 'Waiting for chemistry engine' : 'Empty canvas';
      return;
    }
    var analysis = Chem.analyze(smiles);
    state.analysis = analysis;
    renderProperties(analysis);
    renderReaction(analysis);
    if (activeTab() === 'formats') renderFormats();
  }

  function badge(text, tone) {
    var span = document.createElement('span');
    span.className = 'chip' + (tone ? ' ' + tone : '');
    span.textContent = text;
    return span;
  }

  function addRow(grid, label, value) {
    if (value === null || value === undefined) return;
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    grid.appendChild(dt);
    grid.appendChild(dd);
  }

  function principalProduct(analysis) {
    var best = null;
    var list = analysis.products || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.ok) continue;
      if (!best || (p.mw || 0) > (best.mw || 0)) best = p;
    }
    return best;
  }

  function renderProperties(analysis) {
    var chip = el['kind-chip'];
    var note = el['partial-note'];
    var grid = el['prop-grid'];
    var badges = el['rule-badges'];
    clearNode(grid);
    clearNode(badges);
    note.hidden = true;
    el['elements-box'].hidden = true;

    var info = analysis;
    var label = 'Molecule';

    if (analysis.kind === 'empty') {
      chip.className = 'chip';
      chip.textContent = 'Empty canvas';
      renderFormula(el.formula, '—');
      el.mw.textContent = '—';
      el.exact.textContent = '—';
      return;
    }

    if (analysis.kind === 'reaction') {
      var prod = principalProduct(analysis);
      chip.className = 'chip rxn';
      chip.textContent = 'Reaction scheme · ' + (analysis.reactants || []).length + ' in / ' + (analysis.products || []).length + ' out';
      if (!prod) {
        renderFormula(el.formula, '—');
        el.mw.textContent = '—';
        el.exact.textContent = '—';
        note.hidden = false;
        note.textContent = 'Products could not be parsed. See the Reaction tab for components.';
        return;
      }
      info = prod;
      label = 'Principal product';
    } else {
      chip.className = 'chip mol';
      chip.textContent = info.ok ? (info.partial ? 'Molecule (unsanitized)' : 'Molecule') : 'Unparsed structure';
    }

    if (!info.ok) {
      renderFormula(el.formula, '—');
      el.mw.textContent = '—';
      el.exact.textContent = '—';
      note.hidden = false;
      note.textContent = info.error || 'This structure could not be interpreted.';
      return;
    }

    renderFormula(el.formula, info.formula);
    el.mw.textContent = info.mw != null ? fmt(info.mw, 2) : '—';
    el.exact.textContent = info.exactMass != null ? fmt(info.exactMass, 4) : '—';

    if (info.partial) {
      note.hidden = false;
      note.textContent = info.reason || 'Partial analysis only.';
    }

    if (analysis.kind === 'reaction') badges.appendChild(badge(label, 'rxn'));
    if (!info.partial) {
      badges.appendChild(badge('Lipinski ' + (info.lipinskiPass ? 'pass' : 'fail') + ' (' + info.lipinskiFails + ' viol.)', info.lipinskiPass ? 'ok' : 'off'));
      badges.appendChild(badge('Veber ' + (info.veberPass ? 'pass' : 'fail'), info.veberPass ? 'ok' : 'off'));
      if (info.unspecifiedStereo) badges.appendChild(badge(info.unspecifiedStereo + ' undefined stereocentre' + (info.unspecifiedStereo > 1 ? 's' : ''), 'off'));
    }

    addRow(grid, 'cLogP (Crippen)', info.clogp != null ? fmt(info.clogp, 2) : null);
    addRow(grid, 'TPSA (Å²)', info.tpsa != null ? fmt(info.tpsa, 1) : null);
    addRow(grid, 'H-bond donors', info.hbd != null ? String(info.hbd) : null);
    addRow(grid, 'H-bond acceptors', info.hba != null ? String(info.hba) : null);
    addRow(grid, 'Rotatable bonds', info.rotb != null ? String(info.rotb) : null);
    addRow(grid, 'Rings / aromatic', info.rings != null ? info.rings + ' / ' + (info.aromaticRings != null ? info.aromaticRings : '?') : null);
    addRow(grid, 'Heavy atoms', info.heavyAtoms != null ? String(info.heavyAtoms) : null);
    addRow(grid, 'Heteroatoms', info.heteroatoms != null ? String(info.heteroatoms) : null);
    addRow(grid, 'Stereocentres', info.stereocenters != null ? String(info.stereocenters) : null);
    addRow(grid, 'Fraction Csp3', info.fsp3 != null ? fmt(info.fsp3, 2) : null);
    addRow(grid, 'Molar refractivity', info.mr != null ? fmt(info.mr, 1) : null);
    addRow(grid, 'Labute ASA', info.labuteASA != null ? fmt(info.labuteASA, 1) : null);
    addRow(grid, 'Net charge', info.charge ? (info.charge > 0 ? '+' + info.charge : String(info.charge)) : '0');
    addRow(grid, 'InChIKey', info.inchikey || null);

    if (info.elements) {
      var keys = Object.keys(info.elements).sort(function (a, b) {
        if (a === 'C') return -1;
        if (b === 'C') return 1;
        if (a === 'H') return -1;
        if (b === 'H') return 1;
        return a.localeCompare(b);
      });
      if (keys.length) {
        el['elements-box'].hidden = false;
        var list = el['elements-list'];
        clearNode(list);
        for (var i = 0; i < keys.length; i++) {
          var pill = document.createElement('span');
          pill.className = 'el-pill';
          pill.textContent = keys[i] + ' × ' + info.elements[keys[i]];
          list.appendChild(pill);
        }
      }
    }
  }

  /* ---------- reaction panel ---------- */

  function componentKey(role, index, info) {
    return role + ':' + index + ':' + (info && info.formula ? info.formula : '');
  }

  function renderReaction(analysis) {
    var chip = el['rxn-chip'];
    var body = el['rxn-components'];
    var balanceBody = el['balance-table'];
    clearNode(body);
    clearNode(balanceBody);

    if (!analysis || analysis.kind !== 'reaction') {
      chip.className = 'chip';
      chip.textContent = canvasIsReaction() ? 'Reaction arrow present, no SMILES yet' : 'No reaction on canvas';
      el['rxn-smiles'].value = '';
      el['balance-verdict'].className = 'chip';
      el['balance-verdict'].textContent = '—';
      el['mass-balance'].textContent = '';
      clearNode(el['stoich-ref']);
      clearNode(el['yield-ref']);
      el['yield-out'].textContent = 'Draw a reaction to use the calculator.';
      el['yield-out'].className = 'yield-out muted';
      return;
    }

    chip.className = 'chip rxn';
    chip.textContent = analysis.multiStep
      ? 'Multi-step scheme · overall balance'
      : (analysis.reactants.length + analysis.agents.length) + ' input(s) → ' + analysis.products.length + ' product(s)';
    el['rxn-smiles'].value = analysis.reactionSmiles;

    var rows = [];
    var push = function (role, list) {
      for (var i = 0; i < list.length; i++) rows.push({ role: role, index: i, info: list[i] });
    };
    push('reactant', analysis.reactants);
    push('agent', analysis.agents);
    push('product', analysis.products);

    var refSel = el['stoich-ref'];
    var yieldSel = el['yield-ref'];
    var prevRef = refSel.value;
    var prevYield = yieldSel.value;
    clearNode(refSel);
    clearNode(yieldSel);

    rows.forEach(function (row, idx) {
      var key = componentKey(row.role, row.index, row.info);
      if (row.role !== 'agent' && row.info && row.info.mw != null) {
        var opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = (row.role === 'product' ? 'P' : 'R') + (row.index + 1) + ' · ' + (row.info.formula || '?');
        if (row.role === 'reactant') refSel.appendChild(opt);
        else yieldSel.appendChild(opt.cloneNode(true));
      }
      if (state.equivs[key] === undefined) state.equivs[key] = 1;
    });

    if (prevRef && refSel.querySelector('option[value="' + prevRef + '"]')) refSel.value = prevRef;
    if (prevYield && yieldSel.querySelector('option[value="' + prevYield + '"]')) yieldSel.value = prevYield;

    state.rows = rows;

    rows.forEach(function (row, idx) {
      var info = row.info || {};
      var key = componentKey(row.role, row.index, info);
      var tr = document.createElement('tr');

      var tdRole = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'role-tag' + (row.role === 'product' ? ' product' : '');
      tag.textContent = row.role === 'agent'
        ? 'cat/solv'
        : (row.role === 'product' ? 'P' : 'R') + (row.index + 1);
      tdRole.appendChild(tag);
      tr.appendChild(tdRole);

      var tdFormula = document.createElement('td');
      tdFormula.className = 'formula-cell';
      tdFormula.textContent = info.formula || (info.input || '?');
      tdFormula.title = info.input || '';
      tr.appendChild(tdFormula);

      var tdMw = document.createElement('td');
      tdMw.className = 'num';
      tdMw.textContent = info.mw != null ? fmt(info.mw, 2) : '—';
      tr.appendChild(tdMw);

      var tdEquiv = document.createElement('td');
      tdEquiv.className = 'num';
      if (row.role === 'agent') {
        tdEquiv.textContent = '—';
      } else {
        var inp = document.createElement('input');
        inp.className = 'equiv';
        inp.type = 'number';
        inp.min = '0';
        inp.step = 'any';
        inp.value = String(state.equivs[key]);
        inp.addEventListener('input', function () {
          var v = parseFloat(inp.value);
          state.equivs[key] = isFinite(v) && v >= 0 ? v : 1;
          recomputeStoich();
        });
        tdEquiv.appendChild(inp);
      }
      tr.appendChild(tdEquiv);

      var tdMmol = document.createElement('td');
      tdMmol.className = 'num';
      tdMmol.dataset.cell = 'mmol-' + idx;
      tdMmol.textContent = '—';
      tr.appendChild(tdMmol);

      var tdMass = document.createElement('td');
      tdMass.className = 'num';
      tdMass.dataset.cell = 'mass-' + idx;
      tdMass.textContent = '—';
      tr.appendChild(tdMass);

      body.appendChild(tr);
    });

    var bal = analysis.balance;
    for (var i = 0; i < bal.rows.length; i++) {
      var r = bal.rows[i];
      var trb = document.createElement('tr');
      if (r.delta !== 0) trb.className = 'delta-off';
      [r.element, String(r.left), String(r.right), (r.delta > 0 ? '+' : '') + r.delta].forEach(function (text, ci) {
        var td = document.createElement('td');
        if (ci > 0) td.className = 'num';
        td.textContent = text;
        trb.appendChild(td);
      });
      balanceBody.appendChild(trb);
    }

    var verdict = el['balance-verdict'];
    if (!bal.known) {
      verdict.className = 'chip';
      verdict.textContent = 'incomplete';
    } else if (bal.balanced) {
      verdict.className = 'chip ok';
      verdict.textContent = 'balanced';
    } else {
      verdict.className = 'chip off';
      verdict.textContent = 'not balanced';
    }

    var massDelta = bal.massRight - bal.massLeft;
    if (Math.abs(massDelta) < 0.005) massDelta = 0;
    el['mass-balance'].textContent = bal.massComplete
      ? 'Formula mass: ' + fmt(bal.massLeft, 2) + ' left vs ' + fmt(bal.massRight, 2) + ' right (Δ ' + fmt(massDelta, 2) + ').'
      : 'Formula mass unavailable for some components.';

    recomputeStoich();
  }

  function recomputeStoich() {
    var rows = state.rows || [];
    var refIdx = parseInt(el['stoich-ref'].value, 10);
    var massMg = parseFloat(el['stoich-mass'].value);
    var out = el['yield-out'];

    var clearCells = function () {
      for (var i = 0; i < rows.length; i++) {
        var a = document.querySelector('[data-cell="mmol-' + i + '"]');
        var b = document.querySelector('[data-cell="mass-' + i + '"]');
        if (a) a.textContent = '—';
        if (b) b.textContent = '—';
      }
    };

    if (!rows.length || !isFinite(refIdx) || !rows[refIdx] || !isFinite(massMg) || massMg <= 0) {
      clearCells();
      if (rows.length) {
        out.className = 'yield-out muted';
        out.textContent = 'Enter a mass to scale the scheme.';
      }
      return;
    }

    var ref = rows[refIdx];
    var refKey = componentKey(ref.role, ref.index, ref.info);
    var refEquiv = state.equivs[refKey] || 1;
    var refMw = ref.info && ref.info.mw;
    if (!refMw) {
      clearCells();
      out.className = 'yield-out muted';
      out.textContent = 'Reference component has no molecular weight.';
      return;
    }

    var scale = Chem.stoichiometry({ limitingMw: refMw, limitingMassMg: massMg, equiv: refEquiv });
    if (!scale) {
      clearCells();
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var key = componentKey(row.role, row.index, row.info);
      var cellMmol = document.querySelector('[data-cell="mmol-' + i + '"]');
      var cellMass = document.querySelector('[data-cell="mass-' + i + '"]');
      if (!cellMmol || !cellMass) continue;
      if (row.role === 'agent' || !row.info || row.info.mw == null) {
        cellMmol.textContent = '—';
        cellMass.textContent = '—';
        continue;
      }
      var res = scale.forComponent(row.info.mw, state.equivs[key] || 1);
      cellMmol.textContent = fmt(res.mmol, 3);
      cellMass.textContent = res.massMg >= 1000 ? fmt(res.massMg / 1000, 3) + ' g' : fmt(res.massMg, 1) + ' mg';
    }

    var yIdx = parseInt(el['yield-ref'].value, 10);
    var isolated = parseFloat(el['yield-mass'].value);
    if (isFinite(yIdx) && rows[yIdx] && rows[yIdx].info && rows[yIdx].info.mw != null) {
      var yKey = componentKey(rows[yIdx].role, rows[yIdx].index, rows[yIdx].info);
      var theo = scale.forComponent(rows[yIdx].info.mw, state.equivs[yKey] || 1);
      if (isFinite(isolated) && isolated > 0 && theo.massMg > 0) {
        var pct = (isolated / theo.massMg) * 100;
        out.className = 'yield-out good';
        out.textContent = 'Yield ' + fmt(pct, 1) + '% · theoretical ' + fmt(theo.massMg, 1) + ' mg (' + fmt(theo.mmol, 3) + ' mmol) from ' + fmt(scale.mmol, 3) + ' mmol limiting.';
      } else {
        out.className = 'yield-out muted';
        out.textContent = 'Theoretical ' + fmt(theo.massMg, 1) + ' mg (' + fmt(theo.mmol, 3) + ' mmol). Enter the isolated mass for a yield.';
      }
    } else {
      out.className = 'yield-out muted';
      out.textContent = 'Scaled from ' + fmt(scale.mmol, 3) + ' mmol of the reference.';
    }
  }

  /* ---------- formats panel ---------- */

  function fmtCard(name, value, filename, mime, isError) {
    var card = document.createElement('div');
    card.className = 'fmt' + (isError ? ' err' : '');

    var head = document.createElement('div');
    head.className = 'fmt-head';
    var title = document.createElement('span');
    title.className = 'fmt-name';
    title.textContent = name;
    head.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'fmt-actions';
    if (!isError && value) {
      var copyBtn = document.createElement('button');
      copyBtn.className = 'btn tiny';
      copyBtn.type = 'button';
      copyBtn.textContent = 'copy';
      copyBtn.addEventListener('click', function () { copyText(value, name); });
      actions.appendChild(copyBtn);

      var dlBtn = document.createElement('button');
      dlBtn.className = 'btn tiny';
      dlBtn.type = 'button';
      dlBtn.textContent = 'save';
      dlBtn.addEventListener('click', function () {
        download(slug(el.name.value || 'drawing') + '.' + filename, value, mime);
      });
      actions.appendChild(dlBtn);
    }
    head.appendChild(actions);
    card.appendChild(head);

    var pre = document.createElement('pre');
    pre.textContent = value || 'not available for this structure';
    card.appendChild(pre);
    return card;
  }

  var formatsRun = 0;

  async function renderFormats() {
    /* Two overlapping runs would interleave their cards, so the newest wins. */
    var myRun = ++formatsRun;
    var list = el['formats-list'];
    clearNode(list);
    var k = state.ketcher;
    if (!k) {
      list.appendChild(fmtCard('Editor', '', '', '', true));
      return;
    }
    if (!state.structure) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Draw something to generate text formats.';
      list.appendChild(empty);
      return;
    }

    var isRxn = canvasIsReaction();
    var jobs = [
      { name: 'SMILES', ext: 'smi', mime: 'chemical/x-daylight-smiles', run: function () { return k.getSmiles(); } },
      { name: 'Extended SMILES (CXSMILES)', ext: 'cxsmi', mime: 'text/plain', run: function () { return k.getSmiles(true); } },
      { name: 'SMARTS', ext: 'sma', mime: 'text/plain', run: function () { return k.getSmarts(); } },
      { name: 'KET (native, lossless)', ext: 'ket', mime: 'application/json', run: function () { return k.getKet(); } },
    ];
    if (isRxn) {
      jobs.push({ name: 'RXN V2000', ext: 'rxn', mime: 'chemical/x-mdl-rxnfile', run: function () { return k.getRxn('v2000'); } });
      jobs.push({ name: 'RXN V3000', ext: 'rxn', mime: 'chemical/x-mdl-rxnfile', run: function () { return k.getRxn('v3000'); } });
    } else {
      jobs.push({ name: 'MOL V2000', ext: 'mol', mime: 'chemical/x-mdl-molfile', run: function () { return k.getMolfile('v2000'); } });
      jobs.push({ name: 'MOL V3000', ext: 'mol', mime: 'chemical/x-mdl-molfile', run: function () { return k.getMolfile('v3000'); } });
      jobs.push({ name: 'SDF V2000', ext: 'sdf', mime: 'chemical/x-mdl-sdfile', run: function () { return k.getSdf('v2000'); } });
    }
    jobs.push({ name: 'CML', ext: 'cml', mime: 'chemical/x-cml', run: function () { return k.getCml(); } });

    var analysis = state.analysis;
    var info = analysis && analysis.kind === 'molecule' ? analysis : principalProduct(analysis || {});

    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var value = '';
      var failed = false;
      try {
        value = await job.run();
        if (typeof value !== 'string') value = String(value || '');
      } catch (err) {
        failed = true;
        value = (err && err.message) || 'unavailable';
      }
      if (myRun !== formatsRun) return;
      list.appendChild(fmtCard(job.name, value, job.ext, job.mime, failed || !value));
    }

    if (info && info.ok && info.inchi) {
      list.appendChild(fmtCard(analysis.kind === 'reaction' ? 'InChI (principal product)' : 'InChI', info.inchi, 'inchi', 'text/plain', false));
      if (info.inchikey) {
        list.appendChild(fmtCard(analysis.kind === 'reaction' ? 'InChIKey (principal product)' : 'InChIKey', info.inchikey, 'txt', 'text/plain', false));
      }
    }
    if (info && info.ok && info.smiles) {
      list.appendChild(fmtCard(analysis.kind === 'reaction' ? 'Canonical SMILES (principal product)' : 'Canonical SMILES (RDKit)', info.smiles, 'smi', 'text/plain', false));
    }
  }

  /* ---------- image export ---------- */

  /* Blobs handed back by the iframe belong to its realm, so instanceof is useless here. */
  function isBlobLike(value) {
    return !!value && typeof value === 'object' && typeof value.arrayBuffer === 'function';
  }

  async function blobToText(value) {
    if (typeof value === 'string') return value;
    if (isBlobLike(value)) {
      if (typeof value.text === 'function') return await value.text();
      var buf = await value.arrayBuffer();
      return new TextDecoder('utf-8').decode(buf);
    }
    return String(value || '');
  }

  async function ketcherSvg() {
    var k = state.ketcher;
    if (!k) throw new Error('Editor not ready');
    if (!state.structure) throw new Error('Nothing on the canvas');
    var data = state.lastKet || (await readKet());
    var result = await k.generateImage(data, { outputFormat: 'svg' });
    var text = await blobToText(result);
    if (!text || text.indexOf('<svg') === -1) throw new Error('Editor returned no drawing');
    return text;
  }

  function resizeSvg(svgText, width, height) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return { text: svgText, width: width, height: height };
    var vb = svg.getAttribute('viewBox');
    var nw = parseFloat(svg.getAttribute('width')) || 0;
    var nh = parseFloat(svg.getAttribute('height')) || 0;
    if (!vb && nw && nh) {
      svg.setAttribute('viewBox', '0 0 ' + nw + ' ' + nh);
      vb = '0 0 ' + nw + ' ' + nh;
    }
    var ratio = null;
    if (vb) {
      var p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) ratio = p[3] / p[2];
    } else if (nw && nh) {
      ratio = nh / nw;
    }
    /* Keep the drawing's own aspect: width is the target, height is a cap. */
    var outW = width;
    var outH = height;
    if (ratio) {
      outH = Math.round(width * ratio);
      if (height && outH > height) {
        outH = height;
        outW = Math.round(height / ratio);
      }
      outH = Math.max(32, outH);
      outW = Math.max(32, outW);
    }
    svg.setAttribute('width', String(outW));
    svg.setAttribute('height', String(outH));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    return { text: new XMLSerializer().serializeToString(svg), width: outW, height: outH };
  }

  function svgToPngBlob(svgText, width, height, transparent) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        if (!transparent) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Canvas export failed'));
        }, 'image/png');
      };
      img.onerror = function () { reject(new Error('Could not rasterize the drawing')); };
      img.src = url;
    });
  }

  function exportSize() {
    var w = parseInt(el['img-width'].value, 10);
    var h = parseInt(el['img-height'].value, 10);
    return {
      width: isFinite(w) && w >= 64 ? Math.min(w, 4000) : 900,
      height: isFinite(h) && h >= 64 ? Math.min(h, 4000) : 500,
    };
  }

  async function doExport(kind) {
    try {
      var size = exportSize();
      var raw = await ketcherSvg();
      var sized = resizeSvg(raw, size.width, size.height);
      var base = slug(el.name.value || 'drawing');
      if (kind === 'svg') {
        download(base + '.svg', sized.text, 'image/svg+xml;charset=utf-8');
        toast('SVG saved');
        return;
      }
      var transparent = el['img-transparent'].checked;
      var png = await svgToPngBlob(sized.text, sized.width, sized.height, transparent);
      if (kind === 'png') {
        download(base + '.png', png, 'image/png');
        toast('PNG saved');
        return;
      }
      if (kind === 'copy') {
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Image clipboard not supported here');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast('PNG copied to clipboard');
        return;
      }
      if (kind === 'preview') {
        var holder = el['img-preview'];
        clearNode(holder);
        var img = document.createElement('img');
        img.src = URL.createObjectURL(png);
        img.width = Math.min(sized.width, 520);
        img.alt = 'Rendered drawing';
        holder.appendChild(img);
      }
    } catch (err) {
      toast((err && err.message) || 'Export failed', true);
    }
  }

  /* ---------- library ---------- */

  var libraryCache = [];

  /* Ketcher and RDKit run entirely in the page, so once they are loaded the app
     keeps drawing and computing properties even after the server goes away. The
     only things that still need it are saving and the library - without this the
     first sign of a stopped server is a bare "Failed to fetch" on save. */
  var OFFLINE_MSG = 'ChemBuild server has stopped - restart it, then press Retry';
  var offlineTimer = null;

  function setOffline(down) {
    var bar = el['offline-bar'];
    if (!bar) return;
    bar.hidden = !down;
    if (down && !offlineTimer) offlineTimer = setInterval(pingServer, 4000);
    if (!down && offlineTimer) {
      clearInterval(offlineTimer);
      offlineTimer = null;
    }
  }

  async function pingServer() {
    /* Deliberately bypasses api(): this probe must not re-report the outage. */
    try {
      await fetch('/api/info', { cache: 'no-store' });
    } catch (err) {
      return;
    }
    setOffline(false);
    toast('Server is back - saving works again');
    loadLibrary();
  }

  async function api(path, options) {
    var res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      /* A rejected fetch is a refused connection, not a rejected request. */
      setOffline(true);
      throw new Error(OFFLINE_MSG);
    }
    setOffline(false);
    var data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }

  async function loadLibrary() {
    try {
      var data = await api('/api/drawings');
      libraryCache = (data && data.drawings) || [];
      renderLibrary();
    } catch (err) {
      toast((err && err.message) || 'Could not read the library', true);
    }
  }

  function renderLibrary() {
    var holder = el['library-list'];
    var query = (el['lib-search'].value || '').trim().toLowerCase();
    clearNode(holder);
    var items = libraryCache.filter(function (m) {
      if (!query) return true;
      return (
        String(m.name || '').toLowerCase().indexOf(query) !== -1 ||
        String(m.formula || '').toLowerCase().indexOf(query) !== -1 ||
        String(m.smiles || '').toLowerCase().indexOf(query) !== -1
      );
    });
    el['lib-count'].textContent = String(items.length);

    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = libraryCache.length ? 'No match.' : 'Nothing saved yet. Draw, name it, then Save.';
      holder.appendChild(empty);
      return;
    }

    items.forEach(function (meta) {
      var item = document.createElement('div');
      item.className = 'lib-item' + (meta.id === state.id ? ' current' : '');
      item.setAttribute('role', 'listitem');

      var thumb = document.createElement('div');
      thumb.className = 'lib-thumb' + (meta.hasThumb ? '' : ' empty');
      if (meta.hasThumb) {
        var img = document.createElement('img');
        img.src = '/drawings/' + encodeURIComponent(meta.id) + '.svg?t=' + encodeURIComponent(meta.updated || '');
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        thumb.textContent = meta.kind === 'reaction' ? 'rxn' : 'mol';
      }
      item.appendChild(thumb);

      var metaBox = document.createElement('div');
      metaBox.className = 'lib-meta';
      var nameLine = document.createElement('div');
      nameLine.className = 'lib-name';
      nameLine.textContent = meta.name || 'Untitled';
      metaBox.appendChild(nameLine);
      var sub = document.createElement('div');
      sub.className = 'lib-sub';
      var when = meta.updated ? new Date(meta.updated).toLocaleString() : '';
      sub.textContent = (meta.formula ? meta.formula + ' · ' : '') + when;
      metaBox.appendChild(sub);

      var actions = document.createElement('div');
      actions.className = 'lib-row-actions';
      var openBtn = document.createElement('button');
      openBtn.className = 'link-btn';
      openBtn.type = 'button';
      openBtn.textContent = 'open';
      openBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openDrawing(meta.id);
      });
      actions.appendChild(openBtn);

      var dupBtn = document.createElement('button');
      dupBtn.className = 'link-btn';
      dupBtn.type = 'button';
      dupBtn.textContent = 'duplicate';
      dupBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        duplicateDrawing(meta);
      });
      actions.appendChild(dupBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'link-btn';
      delBtn.type = 'button';
      delBtn.textContent = 'delete';
      var armed = false;
      var timer = null;
      delBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!armed) {
          armed = true;
          delBtn.textContent = 'click again';
          timer = setTimeout(function () {
            armed = false;
            delBtn.textContent = 'delete';
          }, 3500);
          return;
        }
        if (timer) clearTimeout(timer);
        deleteDrawing(meta.id);
      });
      actions.appendChild(delBtn);
      metaBox.appendChild(actions);

      item.appendChild(metaBox);
      item.addEventListener('dblclick', function () { openDrawing(meta.id); });
      holder.appendChild(item);
    });
  }

  async function openDrawing(id) {
    try {
      var data = await api('/api/drawings/' + encodeURIComponent(id));
      if (!state.ketcher) throw new Error('Editor not ready');
      await state.ketcher.setMolecule(data.ket || '');
      state.id = data.meta.id;
      el.name.value = data.meta.name || '';
      state.equivs = {};
      setDirty(false);
      clearDraft();
      renderLibrary();
      scheduleRecompute(120);
      toast('Opened ' + (data.meta.name || 'drawing'));
    } catch (err) {
      toast((err && err.message) || 'Could not open that drawing', true);
    }
  }

  async function duplicateDrawing(meta) {
    try {
      var data = await api('/api/drawings/' + encodeURIComponent(meta.id));
      var created = await api('/api/drawings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: (meta.name || 'Untitled') + ' copy',
          ket: data.ket || '',
          smiles: meta.smiles || '',
          formula: meta.formula || '',
          kind: meta.kind || 'empty',
        }),
      });
      await loadLibrary();
      toast('Duplicated as "' + created.meta.name + '"');
    } catch (err) {
      toast('Duplicate failed', true);
    }
  }

  async function deleteDrawing(id) {
    try {
      await api('/api/drawings/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.id === id) state.id = null;
      await loadLibrary();
      toast('Deleted');
    } catch (err) {
      toast('Delete failed', true);
    }
  }

  async function saveCurrent() {
    if (state.saving) return;
    state.saving = true;
    el['btn-save'].disabled = true;
    var ket = '';
    try {
      if (!state.ketcher) throw new Error('Editor not ready');
      ket = await readKet();
      var smiles = await readStructure();
      var analysis = state.analysis;
      var kind = canvasIsReaction() ? 'reaction' : smiles ? 'molecule' : 'empty';
      var formula = '';
      if (analysis && analysis.kind === 'molecule' && analysis.formula) formula = analysis.formula;
      else if (analysis && analysis.kind === 'reaction') {
        var p = principalProduct(analysis);
        if (p && p.formula) formula = p.formula;
      }
      var thumb = '';
      try {
        thumb = Chem.isReady() ? Chem.svgFor(smiles, kind === 'reaction' ? 320 : 180, 120) : '';
      } catch (err) {
        thumb = '';
      }
      var payload = {
        name: el.name.value.trim() || 'Untitled',
        ket: ket,
        smiles: smiles,
        formula: formula,
        kind: kind,
        svg: thumb,
      };
      var result;
      if (state.id) {
        result = await api('/api/drawings/' + encodeURIComponent(state.id), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        result = await api('/api/drawings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.id = result.meta.id;
      }
      el.name.value = result.meta.name;
      setDirty(false);
      clearDraft();
      await loadLibrary();
      toast('Saved "' + result.meta.name + '"');
    } catch (err) {
      /* Keep the work recoverable: a draft survives a reload, the canvas does not. */
      if (ket) state.lastKet = ket;
      saveDraft();
      toast((err && err.message) || 'Save failed', true);
    } finally {
      state.saving = false;
      el['btn-save'].disabled = false;
    }
  }

  async function newDrawing() {
    try {
      if (state.ketcher) await state.ketcher.setMolecule('');
      state.id = null;
      state.equivs = {};
      el.name.value = '';
      el['stoich-mass'].value = '';
      el['yield-mass'].value = '';
      setDirty(false);
      clearDraft();
      renderLibrary();
      scheduleRecompute(120);
      el.name.focus();
    } catch (err) {
      toast('Could not clear the canvas', true);
    }
  }

  /* ---------- tabs and panels ---------- */

  function activeTab() {
    var current = document.querySelector('.tab.active');
    return current ? current.dataset.tab : 'props';
  }

  function selectTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.tab === name);
    }
    var panels = document.querySelectorAll('.panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('active', panels[j].id === 'panel-' + name);
    }
    if (name === 'formats') renderFormats();
  }

  function applyPanelPrefs() {
    var prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {};
    } catch (err) {
      prefs = {};
    }
    el.layout.classList.toggle('no-lib', prefs.lib === false);
    el.layout.classList.toggle('no-insp', prefs.insp === false);
    el['btn-lib'].setAttribute('aria-pressed', String(prefs.lib !== false));
    el['btn-insp'].setAttribute('aria-pressed', String(prefs.insp !== false));
  }

  function togglePanel(which) {
    var cls = which === 'lib' ? 'no-lib' : 'no-insp';
    el.layout.classList.toggle(cls);
    var visible = !el.layout.classList.contains(cls);
    el['btn-' + (which === 'lib' ? 'lib' : 'insp')].setAttribute('aria-pressed', String(visible));
    try {
      var prefs = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {};
      prefs[which] = visible;
      localStorage.setItem(PANEL_KEY, JSON.stringify(prefs));
    } catch (err) { /* ignore */ }
  }

  /* ---------- wiring ---------- */

  function wire() {
    el['btn-save'].addEventListener('click', saveCurrent);
    el['btn-new'].addEventListener('click', newDrawing);
    el['btn-retry'].addEventListener('click', pingServer);
    el['btn-refresh'].addEventListener('click', function () { scheduleRecompute(0); });
    el['btn-formats-refresh'].addEventListener('click', renderFormats);
    el['btn-lib'].addEventListener('click', function () { togglePanel('lib'); });
    el['btn-insp'].addEventListener('click', function () { togglePanel('insp'); });
    el['lib-search'].addEventListener('input', renderLibrary);
    el.name.addEventListener('input', function () { setDirty(true); });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { selectTab(tab.dataset.tab); });
    });

    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = $(btn.dataset.copy);
        if (target) copyText(target.value, 'Reaction SMILES');
      });
    });

    el['stoich-ref'].addEventListener('change', recomputeStoich);
    el['stoich-mass'].addEventListener('input', recomputeStoich);
    el['yield-ref'].addEventListener('change', recomputeStoich);
    el['yield-mass'].addEventListener('input', recomputeStoich);

    el['btn-png'].addEventListener('click', function () { doExport('png'); });
    el['btn-svg'].addEventListener('click', function () { doExport('svg'); });
    el['btn-copy-png'].addEventListener('click', function () { doExport('copy'); });
    el['btn-preview'].addEventListener('click', function () { doExport('preview'); });

    window.addEventListener('keydown', function (ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return;
      var key = ev.key.toLowerCase();
      if (key === 's') {
        ev.preventDefault();
        saveCurrent();
      } else if (key === 'b') {
        ev.preventDefault();
        togglePanel('lib');
      } else if (key === 'i' && !ev.shiftKey) {
        ev.preventDefault();
        togglePanel('insp');
      } else if (key === 'n' && ev.altKey) {
        ev.preventDefault();
        newDrawing();
      }
    });

    window.addEventListener('beforeunload', function (ev) {
      if (state.dirty) {
        saveDraft();
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  async function restoreDraft() {
    var draft = readDraft();
    if (!draft || !draft.ket || !state.ketcher) return;
    try {
      await state.ketcher.setMolecule(draft.ket);
      state.id = draft.id || null;
      el.name.value = draft.name || '';
      setDirty(true);
      toast('Restored unsaved work');
    } catch (err) { /* draft unusable */ }
  }

  async function boot() {
    cacheEls();
    wire();
    applyPanelPrefs();
    loadLibrary();

    api('/api/info').then(function (info) {
      if (info && info.drawingsDir) el['lib-path'].textContent = info.drawingsDir;
    }).catch(function () { /* label stays generic */ });

    Chem.load().then(function () {
      el.engine.className = 'engine ready';
      el.engine.textContent = 'RDKit ' + Chem.version();
      scheduleRecompute(0);
    }).catch(function (err) {
      el.engine.className = 'engine failed';
      el.engine.textContent = 'engine failed';
      toast('Chemistry engine failed to load: ' + ((err && err.message) || 'unknown'), true);
    });

    try {
      var ketcher = await waitForKetcher();
      state.ketcher = ketcher;
      el['canvas-veil'].hidden = true;
      hookChangeEvents(ketcher);
      await restoreDraft();
      scheduleRecompute(150);
    } catch (err) {
      el['canvas-veil'].textContent = 'The structure editor did not load. Reload the page.';
      toast('Editor failed to start', true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
