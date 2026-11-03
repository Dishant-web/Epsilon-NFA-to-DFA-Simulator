/**
 * app.js — UI controller.
 * One automaton model (app.nfa) is the single source of truth. The diagram, the transition
 * table and every derived view are re-rendered from it, so they cannot drift apart.
 */
(function () {
  'use strict';

  const A = window.Automata;
  const D = window.Diagram;
  const EPS = A.EPS;
  const esc = D.escapeHtml;
  const L = A.subsetLabel;
  const W = D.DEFAULT_WIDTH;
  const H = D.DEFAULT_HEIGHT;

  const TABS = [
    ['converter', 'Automata Converter'],
    ['steps', 'Step-by-Step Solution'],
    ['tester', 'String Tester'],
    ['roadmap', 'Milestone 2 Roadmap'],
  ];

  const TYPE_LABEL = {
    start: 'Start',
    process: 'Process state',
    move: 'Compute move',
    closure: 'Compute ε-closure',
    discover: 'New DFA state',
    transition: 'Add transition',
    complete: 'Complete',
  };

  const app = {
    tab: 'converter',
    nfa: A.cloneAutomaton(A.SAMPLES.textbook.nfa),
    sample: 'textbook',
    pos: {},
    showDFA: true,
    conv: null,
    connect: null,
    flash: '',
    step: 0,
    view: 'step',
    playing: false,
    timer: null,
    testInput: '',
    testResult: null,
    verifyLen: 5,
    verifyResult: null,
  };

  const root = document.getElementById('app');
  let suppressClick = false;
  let drag = null;

  // ================================================================ derived data

  function conversion() {
    const errors = A.validate(app.nfa);
    if (errors.length) return { errors };
    const sig = JSON.stringify(app.nfa);
    if (!app.conv || app.conv.sig !== sig) {
      const { dfa, trace } = A.subsetConstruction(app.nfa);
      app.conv = { dfa, trace, sig };
      app.step = 0;
    }
    return { conv: app.conv };
  }

  function addEdge(map, from, to, sym) {
    const key = from + '>' + to;
    if (!map.has(key)) map.set(key, { from, to, labels: [] });
    map.get(key).labels.push({ text: sym, eps: sym === EPS });
  }

  function nfaGraph() {
    const { states, finals, initial, transitions } = app.nfa;
    const nodes = states.map((s) => ({ id: s, label: s, initial: s === initial, final: finals.includes(s), trap: false }));
    const edges = new Map();
    for (const from of Object.keys(transitions)) {
      for (const sym of Object.keys(transitions[from])) {
        for (const to of transitions[from][sym]) addEdge(edges, from, to, sym);
      }
    }
    return { nodes, edges: [...edges.values()] };
  }

  function nodeOf(id, members, accepting, trap, initial) {
    return { id, label: L(members), sub: id + (trap ? ' · trap' : ''), final: !!accepting, initial: !!initial, trap: !!trap };
  }

  function graphFromDfa(dfa) {
    const nodes = dfa.states.map((s) => nodeOf(s.id, s.members, s.accepting, s.trap, s.initial));
    const edges = new Map();
    for (const s of dfa.states) {
      for (const sym of dfa.alphabet) {
        const to = dfa.transitions[s.id] && dfa.transitions[s.id][sym];
        if (to) addEdge(edges, s.id, to, sym);
      }
    }
    return { nodes, edges: [...edges.values()] };
  }

  /** The DFA as it exists after trace event `upto` (used by the step-by-step view). */
  function graphFromTrace(trace, upto) {
    const nodes = new Map();
    const edges = new Map();
    for (let i = 0; i <= upto && i < trace.length; i++) {
      const ev = trace[i];
      if (ev.type === 'start' || ev.type === 'discover') {
        nodes.set(ev.id, nodeOf(ev.id, ev.members, ev.accepting, ev.trap, ev.type === 'start'));
      }
      if (ev.type === 'transition') addEdge(edges, ev.from, ev.to, ev.symbol);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  function focusOf(ev) {
    switch (ev.type) {
      case 'closure':
      case 'transition':
        return ev.closure;
      case 'move':
      case 'start':
      case 'process':
      case 'discover':
        return ev.members;
      default:
        return [];
    }
  }

  function traceLength() {
    const c = conversion();
    return c.conv ? c.conv.trace.length : 0;
  }

  // ================================================================ mutations

  function renameState(oldName, newName) {
    const n = app.nfa;
    n.states = n.states.map((s) => (s === oldName ? newName : s));
    n.finals = n.finals.map((s) => (s === oldName ? newName : s));
    if (n.initial === oldName) n.initial = newName;
    const next = {};
    for (const from of Object.keys(n.transitions)) {
      const row = {};
      for (const sym of Object.keys(n.transitions[from])) {
        row[sym] = n.transitions[from][sym].map((s) => (s === oldName ? newName : s));
      }
      next[from === oldName ? newName : from] = row;
    }
    n.transitions = next;
    if (app.pos[oldName]) {
      app.pos[newName] = app.pos[oldName];
      delete app.pos[oldName];
    }
  }

  function addState() {
    let i = app.nfa.states.length;
    let name;
    do {
      name = 'q' + i;
      i++;
    } while (app.nfa.states.includes(name));
    app.nfa.states.push(name);
    if (app.nfa.initial === null) app.nfa.initial = name;
  }

  function removeState(s) {
    if (s === undefined) return;
    const n = app.nfa;
    n.states = n.states.filter((x) => x !== s);
    n.finals = n.finals.filter((x) => x !== s);
    if (n.initial === s) n.initial = null;
    delete n.transitions[s];
    for (const from of Object.keys(n.transitions)) {
      for (const sym of Object.keys(n.transitions[from])) {
        A.setTargets(n, from, sym, n.transitions[from][sym].filter((t) => t !== s));
      }
    }
    delete app.pos[s];
    app.connect = null;
  }

  function addTransition(from, sym, to) {
    A.setTargets(app.nfa, from, sym, [...A.getTargets(app.nfa, from, sym), to]);
  }

  function loadSample(key) {
    stopPlay();
    app.sample = key;
    app.nfa = key && A.SAMPLES[key] ? A.cloneAutomaton(A.SAMPLES[key].nfa) : A.newAutomaton();
    app.pos = {};
    app.showDFA = !!key;
    app.connect = null;
    app.conv = null;
    app.step = 0;
    app.testResult = null;
    app.verifyResult = null;
  }

  function commitRename(input) {
    const idx = +input.dataset.index;
    const oldName = app.nfa.states[idx];
    const next = input.value.trim();
    if (oldName === undefined || next === oldName) {
      input.value = oldName === undefined ? '' : oldName;
      return;
    }
    let problem = null;
    if (!next) problem = 'State names cannot be empty.';
    else if (!A.isValidStateName(next)) problem = `"${next}" is not a valid state name (letters, digits, _ or ', max 12 characters).`;
    else if (app.nfa.states.includes(next)) problem = `A state named "${next}" already exists.`;
    if (problem) {
      input.value = oldName;
      app.flash = problem;
      setSlot('flash-slot', flashHtml());
      return;
    }
    renameState(oldName, next);
    refreshSlots(true);
  }

  function setCell(from, sym, text) {
    A.setTargets(app.nfa, from, sym, A.parseList(text));
  }

  // ================================================================ step navigation

  function setStep(n) {
    const len = traceLength();
    app.step = Math.max(0, Math.min(n, len - 1));
    if (app.step >= len - 1) stopPlay();
  }

  function togglePlay() {
    if (app.playing) {
      stopPlay();
      return;
    }
    const len = traceLength();
    if (!len) return;
    if (app.step >= len - 1) app.step = 0;
    app.playing = true;
    app.timer = setInterval(() => {
      const n = traceLength();
      if (app.step >= n - 1) stopPlay();
      else app.step += 1;
      renderMain();
    }, 900);
  }

  function stopPlay() {
    if (app.timer) clearInterval(app.timer);
    app.timer = null;
    app.playing = false;
  }

  // ================================================================ tests & verification

  function runTest() {
    const c = conversion();
    if (c.errors) {
      app.flash = 'Fix the automaton before testing strings.';
      return;
    }
    const input = app.testInput;
    app.testResult = {
      input,
      dfa: A.runDFA(c.conv.dfa, input),
      nfaAccepted: A.nfaAccepts(app.nfa, input),
    };
  }

  function runVerify() {
    const c = conversion();
    if (c.errors) {
      app.flash = 'Fix the automaton before running the equivalence check.';
      return;
    }
    app.verifyResult = A.verifyEquivalence(app.nfa, c.conv.dfa, app.verifyLen);
  }

  // ================================================================ export

  function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(filename, rows) {
    const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv(which) {
    if (which === 'nfa') {
      const cols = [...app.nfa.alphabet, EPS];
      const rows = [['State', 'Start', 'Final', ...cols]];
      for (const s of app.nfa.states) {
        rows.push([
          s,
          s === app.nfa.initial ? 'yes' : '',
          app.nfa.finals.includes(s) ? 'yes' : '',
          ...cols.map((c) => A.getTargets(app.nfa, s, c).join(', ')),
        ]);
      }
      download('enfa_transition_table.csv', rows);
      return;
    }
    const c = conversion();
    if (c.errors) {
      app.flash = 'Fix the automaton before exporting the DFA.';
      return;
    }
    const { dfa } = c.conv;
    const rows = [['DFA state', 'Subset of NFA states', 'Start', 'Accepting', 'Trap', ...dfa.alphabet]];
    for (const s of dfa.states) {
      rows.push([
        s.id,
        s.label,
        s.initial ? 'yes' : '',
        s.accepting ? 'yes' : '',
        s.trap ? 'yes' : '',
        ...dfa.alphabet.map((a) => dfa.transitions[s.id][a]),
      ]);
    }
    download('dfa_transition_table.csv', rows);
  }

  // ================================================================ shared HTML helpers

  function flashHtml() {
    return app.flash ? `<div class="flash" role="status">${esc(app.flash)}</div>` : '';
  }

  function alertHtml(kind, title, items) {
    const list = items && items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
    return `<div class="alert ${kind}"><strong>${esc(title)}</strong>${list}</div>`;
  }

  function legendHtml() {
    return `<div class="legend">
      <span><i class="sw sw-start"></i>start</span>
      <span><i class="sw sw-final"></i>accepting (double outline)</span>
      <span><i class="sw sw-active"></i>active</span>
      <span><i class="sw sw-trap"></i>trap ∅</span>
      <span><i class="sw sw-eps"></i>ε-transition (dashed)</span>
    </div>`;
  }

  function roles(s) {
    const r = [];
    if (s.initial) r.push('<span class="flag init">start</span>');
    if (s.accepting) r.push('<span class="flag fin">accepting</span>');
    if (s.trap) r.push('<span class="flag trap">trap</span>');
    return r.join(' ') || '<span class="muted">—</span>';
  }

  function viewToggle(active) {
    return `<div class="toolbar-row">
      <div class="seg" role="group" aria-label="View">
        <button class="seg-btn ${active === 'step' ? 'active' : ''}" data-action="view" data-view="step">Step-by-step</button>
        <button class="seg-btn ${active === 'solution' ? 'active' : ''}" data-action="view" data-view="solution">Complete solution</button>
      </div>
    </div>`;
  }

  // ================================================================ converter: definition

  function definitionHtml() {
    const { states, alphabet, initial, finals } = app.nfa;
    const rows = states.map((s, i) => `
      <tr>
        <td><input class="input name-input" value="${esc(s)}" data-rename data-index="${i}" aria-label="Name of state ${esc(s)}"></td>
        <td class="c"><input type="radio" name="initial" value="${i}" ${initial === s ? 'checked' : ''} aria-label="Initial state"></td>
        <td class="c"><input type="checkbox" data-final="${i}" ${finals.includes(s) ? 'checked' : ''} aria-label="Accepting state"></td>
        <td class="c"><button class="icon-btn danger" data-action="del-state" data-index="${i}" title="Delete state" aria-label="Delete state ${esc(s)}">✕</button></td>
      </tr>`).join('');

    return `
      <div class="field">
        <label for="alphabet">Input alphabet Σ</label>
        <input id="alphabet" class="input" value="${esc(alphabet.join(', '))}" placeholder="e.g. a, b">
        <p class="hint">Single characters separated by commas. ε is reserved for ε-transitions.</p>
      </div>
      <div class="field">
        <div class="row-between">
          <label>States Q</label>
          <button class="btn small" data-action="add-state">+ Add state</button>
        </div>
        ${states.length
          ? `<table class="states"><thead><tr><th>Name</th><th>Initial</th><th>Final</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="empty">No states yet. Click “+ Add state” or load a sample.</p>'}
        <p class="hint">Rename a state by editing its name. Renames update the diagram and table.</p>
      </div>`;
  }

  // ================================================================ converter: diagram

  function diagramHtml() {
    if (!app.nfa.states.length) {
      return '<div class="canvas-empty">No states yet. Add states to draw the automaton.</div>';
    }
    const c = app.connect;
    let hint = 'Drag states to rearrange them. Use “+ Add transition”, then click a source and a destination state.';
    if (c) {
      if (!c.from) hint = 'Click the <b>source</b> state.';
      else if (!c.to) hint = `From <b>${esc(c.from)}</b>: click the <b>destination</b> state (the same state creates a self-loop).`;
      else hint = '';
    }
    let chooser = '';
    if (c && c.from && c.to) {
      const symbols = [...app.nfa.alphabet, EPS];
      chooser = `<div class="chooser">
        <span>${esc(c.from)} → ${esc(c.to)} on:</span>
        ${symbols.map((sym) => `<button class="btn small" data-action="pick-symbol" data-sym="${esc(sym)}">${sym === EPS ? 'ε' : esc(sym)}</button>`).join('')}
        <button class="btn small ghost" data-action="cancel-connect">Cancel</button>
      </div>`;
    }
    const r = D.renderGraph(nfaGraph(), { kind: 'nfa', idPrefix: 'nfa', positions: app.pos, label: 'ε-NFA transition diagram' });
    app.pos = r.positions;
    return `${hint ? `<p class="hint hint-live">${hint}</p>` : ''}${chooser}
      <div class="diagram-box">${r.svg}</div>${legendHtml()}`;
  }

  function refreshDiagram() {
    setSlot('nfa-diagram', diagramHtml());
  }

  // ================================================================ converter: table

  function tableHtml() {
    const { states, alphabet, initial, finals } = app.nfa;
    if (!states.length) return '<p class="empty">Add states to see the transition table.</p>';
    const cols = [...alphabet, EPS];
    const head = cols.map((c) => `<th class="${c === EPS ? 'eps-col' : ''}">${c === EPS ? 'ε' : esc(c)}</th>`).join('');
    const body = states.map((s) => {
      const flags = [
        initial === s ? '<span class="flag init">start</span>' : '',
        finals.includes(s) ? '<span class="flag fin">final</span>' : '',
      ].join(' ');
      const cells = cols.map((c) => {
        const targets = A.getTargets(app.nfa, s, c);
        return `<td class="${c === EPS ? 'eps-col' : ''}"><input class="cell" value="${esc(targets.join(', '))}" data-from="${esc(s)}" data-sym="${esc(c)}" aria-label="Destinations of ${esc(s)} on ${esc(c)}" placeholder="—"></td>`;
      }).join('');
      return `<tr><th class="row-head">${esc(s)} ${flags}</th>${cells}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="grid">
      <thead><tr><th>State</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="hint">Destinations are comma-separated (e.g. <code>q1, q2</code>); leave a cell empty for no transition. Press Enter or click away to commit. Edits appear in the diagram immediately.</p>`;
  }

  // ================================================================ converter: validation & conversion

  function validationHtml() {
    const errors = A.validate(app.nfa);
    if (errors.length) return alertHtml('error', `${errors.length} issue(s) to fix before converting`, errors);
    return alertHtml('ok', '✓ The automaton is valid and ready to convert.');
  }

  function dfaStatesHtml(dfa) {
    const rows = dfa.states.map((s) => `<tr><td><code>${s.id}</code></td><td>${esc(s.label)}</td><td>${roles(s)}</td></tr>`).join('');
    return `<div class="table-wrap"><table class="grid compact">
      <thead><tr><th>DFA state</th><th>Subset of NFA states</th><th>Roles</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function dfaTableHtml(dfa) {
    const head = dfa.alphabet.map((a) => `<th>${esc(a)}</th>`).join('');
    const body = dfa.states.map((s) => {
      const cells = dfa.alphabet.map((a) => {
        const t = dfa.transitions[s.id][a];
        const target = dfa.states.find((x) => x.id === t);
        return `<td><b>${t}</b><div class="subset">${esc(target.label)}</div></td>`;
      }).join('');
      return `<tr><th class="row-head">${s.id} ${roles(s)}<div class="subset">${esc(s.label)}</div></th>${cells}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="grid">
      <thead><tr><th>State</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function conversionHtml() {
    const toolbar = `<div class="toolbar-row">
      <button class="btn primary" data-action="convert" ${A.validate(app.nfa).length ? 'disabled' : ''}>Convert to DFA</button>
      <button class="btn" data-action="clear">Clear workspace</button>
    </div>`;
    if (!app.showDFA) {
      return toolbar + '<p class="placeholder">Click <b>Convert to DFA</b> to run the subset construction on this automaton. Once converted, the DFA updates live as you edit.</p>';
    }
    const c = conversion();
    if (c.errors) return toolbar + '<p class="placeholder">Fix the validation issues above to see the DFA.</p>';

    const { dfa } = c.conv;
    const accepting = dfa.states.filter((s) => s.accepting).map((s) => s.id);
    const trap = dfa.states.find((s) => s.trap);
    const graph = graphFromDfa(dfa);
    const positions = D.layout(graph.nodes, W, H);
    const svg = D.renderGraph(graph, { kind: 'dfa', idPrefix: 'dfa', positions, label: 'DFA transition diagram' }).svg;

    const trapBox = trap
      ? `<div class="callout"><b>Why a trap state?</b>
          <p>A DFA must define a transition for every state and every symbol. When a move leads to no NFA state (the empty subset ∅), the simulation can never reach a final state again. That subset is shown explicitly as ${trap.id}, with self-loops on every symbol.</p></div>`
      : '';

    return `${toolbar}
      <div class="summary">
        <div class="stat"><span>DFA states</span><b>${dfa.states.length}</b></div>
        <div class="stat"><span>Initial</span><b>${dfa.initial}</b></div>
        <div class="stat"><span>Accepting</span><b>${accepting.join(', ') || '∅'}</b></div>
        <div class="stat"><span>Trap state</span><b>${trap ? trap.id : 'not needed'}</b></div>
      </div>
      <div class="split">
        <div>
          <h3>DFA states</h3>
          ${dfaStatesHtml(dfa)}
          <h3>DFA transition table</h3>
          ${dfaTableHtml(dfa)}
          ${trapBox}
          <div class="toolbar-row">
            <button class="btn small" data-action="export" data-which="dfa">Export DFA CSV</button>
            <button class="btn small" data-action="export" data-which="nfa">Export ε-NFA CSV</button>
            <button class="btn small" data-action="open-steps">See the step-by-step solution →</button>
          </div>
        </div>
        <div>
          <h3>DFA transition diagram</h3>
          <div class="diagram-box">${svg}</div>
          ${legendHtml()}
        </div>
      </div>`;
  }

  function viewConverter() {
    const sampleOptions = Object.entries(A.SAMPLES)
      .map(([k, s]) => `<option value="${k}" ${k === app.sample ? 'selected' : ''}>${esc(s.label)}</option>`)
      .join('');
    const desc = A.SAMPLES[app.sample] ? `<p class="intro-sample">${esc(A.SAMPLES[app.sample].description)}</p>` : '';
    return `
      <div class="intro">
        <p>Define an ε-NFA in the <b>diagram</b> or the <b>transition table</b>. Both edit the same automaton, so they always stay in sync. Then convert it to a DFA with the subset construction.</p>
      </div>
      <div class="grid-2">
        <section class="panel">
          <header class="panel-head">
            <h2>1 · Automaton definition</h2>
            <div class="sample-picker">
              <label for="sample-select">Sample</label>
              <select id="sample-select" data-sample-select>
                ${sampleOptions}
                <option value="" ${app.sample === '' ? 'selected' : ''}>— Blank workspace —</option>
              </select>
            </div>
          </header>
          ${desc}
          ${definitionHtml()}
          <div id="validation">${validationHtml()}</div>
        </section>
        <section class="panel">
          <header class="panel-head">
            <h2>2 · Transition diagram (ε-NFA)</h2>
            <button class="btn small ${app.connect ? 'active' : ''}" data-action="toggle-connect">${app.connect ? 'Cancel adding' : '+ Add transition'}</button>
          </header>
          <div id="nfa-diagram">${diagramHtml()}</div>
        </section>
      </div>
      <section class="panel">
        <header class="panel-head">
          <h2>3 · Transition table (ε-NFA)</h2>
          <span class="muted">Same data as the diagram</span>
        </header>
        <div id="nfa-table">${tableHtml()}</div>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>4 · Convert to DFA</h2></header>
        <div id="conversion">${conversionHtml()}</div>
      </section>`;
  }

  // ================================================================ step-by-step

  function eventRows(ev, dfa) {
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    const code = (v) => `<code>${esc(v)}</code>`;
    const yn = (b) => (b ? 'yes' : 'no');
    const name = (id) => {
      const s = dfa.states.find((x) => x.id === id);
      return s ? `${id} = ${esc(s.label)}` : esc(id);
    };
    switch (ev.type) {
      case 'start':
        return [row('Initial DFA state', name(ev.id)), row('Accepting', yn(ev.accepting))];
      case 'process':
        return [row('Current state', name(ev.id))];
      case 'move':
        return [
          row('Current state S', name(ev.from)),
          row('Symbol a', code(ev.symbol)),
          row('move(S, a)', esc(L(ev.move))),
        ];
      case 'closure':
        return [
          row('move(S, a)', esc(L(ev.move))),
          row('ε-closure(move(S, a))', esc(L(ev.closure))),
        ];
      case 'discover':
        return [row('New DFA state', name(ev.id)), row('Accepting', yn(ev.accepting)), row('Trap (∅)', yn(ev.trap))];
      case 'transition':
        return [
          row(`δ(${esc(ev.from)}, ${esc(ev.symbol)})`, `<b>${ev.to}</b>`),
          row('Target subset', name(ev.to)),
          row('Newly created', yn(ev.isNew)),
        ];
      case 'complete':
        return [row('Reachable DFA states', String(ev.count))];
      default:
        return [];
    }
  }

  function viewSteps() {
    const c = conversion();
    if (c.errors) {
      return alertHtml('error', 'Fix these issues before stepping through the conversion:', c.errors);
    }
    if (app.view === 'solution') return viewToggle('solution') + solutionHtml(c.conv);

    const { dfa, trace } = c.conv;
    const last = trace.length - 1;
    const idx = Math.min(Math.max(app.step, 0), last);
    const ev = trace[idx];
    const focus = focusOf(ev);
    const active = ev.type === 'transition' ? ev.from : ev.id || ev.from || null;

    const dfaPositions = D.layout(graphFromDfa(dfa).nodes, W, H);
    const dfaSvg = D.renderGraph(graphFromTrace(trace, idx), {
      kind: 'dfa-trace',
      idPrefix: 'trace-dfa',
      positions: dfaPositions,
      highlightNodes: active ? [active] : [],
      highlightEdge: ev.type === 'transition' ? { from: ev.from, to: ev.to } : null,
      label: 'DFA under construction',
    }).svg;
    const nfaSvg = D.renderGraph(nfaGraph(), {
      kind: 'nfa-ro',
      idPrefix: 'trace-nfa',
      positions: app.pos,
      highlightNodes: focus,
      label: 'ε-NFA with the current subset highlighted',
    }).svg;

    const atStart = idx === 0;
    const atEnd = idx === last;
    const log = trace.slice(0, idx + 1).map((e, i) =>
      `<li class="${i === idx ? 'current' : ''}"><button class="log-btn" data-action="goto" data-step="${i}">${i + 1}. ${esc(e.short)}</button></li>`
    ).join('');

    return `${viewToggle('step')}
      <div class="steps-grid">
        <section class="panel">
          <div class="controls">
            <button class="btn" data-action="reset-steps">↺ Reset</button>
            <button class="btn" data-action="prev" ${atStart ? 'disabled' : ''}>◀ Previous</button>
            <button class="btn primary" data-action="play" ${atEnd && !app.playing ? 'disabled' : ''}>${app.playing ? '❚❚ Pause' : '▶ Play'}</button>
            <button class="btn" data-action="next" ${atEnd ? 'disabled' : ''}>Next ▶</button>
            <span class="counter">Step ${idx + 1} of ${trace.length}</span>
          </div>
          <div class="event event-${ev.type}">
            <span class="badge">${TYPE_LABEL[ev.type]}</span>
            <p class="event-text">${esc(ev.text)}</p>
            <table class="kv">${eventRows(ev, dfa).join('')}</table>
          </div>
          <h4>Execution log</h4>
          <ol class="log">${log}</ol>
        </section>
        <section class="steps-visuals">
          <div class="panel">
            <h4>ε-NFA · highlighted: ${esc(focus.length ? L(focus) : '—')}</h4>
            <div class="diagram-box">${nfaSvg}</div>
          </div>
          <div class="panel">
            <h4>DFA built so far</h4>
            <div class="diagram-box">${dfaSvg}</div>
            ${legendHtml()}
          </div>
        </section>
      </div>`;
  }

  function solutionHtml(conv) {
    const { dfa, trace } = conv;
    const { nfa } = app;
    const byId = (id) => dfa.states.find((s) => s.id === id);
    const closureRows = nfa.states.map((s) =>
      `<tr><td><code>${esc(s)}</code></td><td>${esc(L(A.epsilonClosure(nfa, [s])))}</td></tr>`
    ).join('');
    const derivRows = trace.filter((e) => e.type === 'transition').map((e) =>
      `<tr><td>${e.from} = ${esc(byId(e.from).label)}</td><td><code>${esc(e.symbol)}</code></td>` +
      `<td>${esc(L(e.move))}</td><td>${esc(L(e.closure))}</td>` +
      `<td><b>${e.to}</b> = ${esc(byId(e.to).label)}</td></tr>`
    ).join('');
    const finals = dfa.finals.join(', ') || '∅';

    return `${viewToggle('solution')}
      <section class="panel">
        <header class="panel-head"><h2>1 · The input ε-NFA</h2></header>
        <p class="tuple">M = (Q, Σ, δ, q₀, F) with Q = {${esc(nfa.states.join(', '))}}, Σ = {${esc(nfa.alphabet.join(', '))}}, q₀ = ${esc(nfa.initial || '—')}, F = {${esc(nfa.finals.join(', '))}}</p>
        <h3>ε-closures of each NFA state</h3>
        <div class="table-wrap"><table class="grid compact">
          <thead><tr><th>State q</th><th>ε-closure({q})</th></tr></thead><tbody>${closureRows}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>2 · Subset construction derivation</h2></header>
        <p class="hint">Every DFA transition, with the move and ε-closure that produced it.</p>
        <div class="table-wrap"><table class="grid compact">
          <thead><tr><th>DFA state S</th><th>a</th><th>move(S, a)</th><th>ε-closure(move(S, a))</th><th>δ_D(S, a)</th></tr></thead>
          <tbody>${derivRows}</tbody>
        </table></div>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>3 · The resulting DFA</h2></header>
        <p class="tuple">D = (Q_D, Σ, δ_D, S₀, F_D)</p>
        <p>Q_D = {${dfa.states.map((s) => s.id).join(', ')}}</p>
        <p>Σ = {${esc(dfa.alphabet.join(', '))}}</p>
        <p>S₀ = ${byId(dfa.initial).id} = ${esc(byId(dfa.initial).label)}</p>
        <p>F_D = {${finals}}</p>
        ${dfaStatesHtml(dfa)}
        ${dfaTableHtml(dfa)}
      </section>
      <section class="panel">
        <details>
          <summary>Full execution log (${trace.length} steps)</summary>
          <ol class="trace-list">${trace.map((e) => `<li>${esc(e.text)}</li>`).join('')}</ol>
        </details>
      </section>`;
  }

  // ================================================================ string tester

  function testResultHtml(t, dfa) {
    const shown = t.input === '' ? 'ε (empty string)' : `"${t.input}"`;
    if (t.dfa.error) {
      return `${alertHtml('error', `${shown} is rejected`, [t.dfa.error])}`;
    }
    const verdict = t.dfa.accepted
      ? `<div class="verdict accepted">ACCEPTED</div>`
      : `<div class="verdict rejected">REJECTED</div>`;
    const agree = t.dfa.accepted === t.nfaAccepted
      ? '<p class="ok-text">✓ The ε-NFA simulation gives the same verdict.</p>'
      : '<p class="bad-text">✗ Disagreement between DFA and ε-NFA. This indicates a bug.</p>';
    const labelOf = (id) => esc(dfa.states.find((s) => s.id === id).label);
    const rows = t.dfa.steps.map((s) =>
      `<tr><td>${s.position}</td><td><code>${esc(s.symbol)}</code></td><td>${s.from} ${labelOf(s.from)}</td><td>→ <b>${s.to}</b> ${labelOf(s.to)}</td></tr>`
    ).join('');
    const table = rows
      ? `<div class="table-wrap"><table class="grid compact">
          <thead><tr><th>#</th><th>Symbol</th><th>Current state</th><th>Next state</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : `<p class="hint">No symbols to read. The verdict depends only on whether the initial state ${dfa.initial} is accepting.</p>`;
    return `<p class="test-shown">Input ${esc(shown)}</p>${verdict}${agree}${table}`;
  }

  function verifyHtml(v) {
    if (v.equivalent) {
      return alertHtml('ok', `✓ Agreement on all ${v.tested} strings of length ≤ ${v.maxLength}.`);
    }
    const items = v.mismatches.map((m) =>
      `"${m.input || 'ε'}": ε-NFA ${m.nfa ? 'accepts' : 'rejects'}, DFA ${m.dfa ? 'accepts' : 'rejects'}`
    );
    return alertHtml('error', `${v.mismatchCount} disagreement(s) found`, items);
  }

  function viewTester() {
    const c = conversion();
    const alpha = app.nfa.alphabet.join(', ') || '—';
    if (c.errors) {
      return `<section class="panel">${alertHtml('error', 'Fix the automaton before testing strings.', c.errors)}</section>`;
    }
    const lengths = [0, 1, 2, 3, 4, 5, 6, 7]
      .map((n) => `<option value="${n}" ${n === app.verifyLen ? 'selected' : ''}>${n}</option>`)
      .join('');
    return `
      <section class="panel">
        <header class="panel-head">
          <h2>Test strings against the DFA</h2>
          <span class="muted">Σ = {${esc(alpha)}}</span>
        </header>
        <div class="row">
          <input id="test-input" class="input mono" value="${esc(app.testInput)}" placeholder="Type a string, e.g. aab (empty = ε)" aria-label="Input string">
          <button class="btn primary" data-action="run-test">Run</button>
        </div>
        ${app.testResult ? testResultHtml(app.testResult, c.conv.dfa) : '<p class="placeholder">Enter a string and press Run (or Enter).</p>'}
      </section>
      <section class="panel">
        <header class="panel-head"><h2>Equivalence check: DFA vs ε-NFA</h2></header>
        <p class="hint">Runs both simulations on every string up to the chosen length, and reports any disagreement.</p>
        <div class="row">
          <label for="verify-len">Max length</label>
          <select id="verify-len" data-verify-len>${lengths}</select>
          <button class="btn" data-action="verify">Run check</button>
        </div>
        ${app.verifyResult ? verifyHtml(app.verifyResult) : ''}
      </section>`;
  }

  // ================================================================ roadmap

  function viewRoadmap() {
    const done = [
      'Single automaton model shared by the diagram and the transition table',
      'Diagram editing: add states, rename, mark start/accepting, drag to arrange, add transitions (including ε and self-loops)',
      'Transition table with multiple destinations per cell and a dedicated ε column',
      'Validation with specific, actionable error messages',
      'Subset construction with a worklist, canonical subsets, explicit trap state, unreachable subsets excluded',
      'Step-by-step trace: start, process, move, ε-closure, discover, transition, complete; with previous/next/play/reset/jump',
      'Complete solution view generated from the executed algorithm (ε-closures, derivation table, DFA tuple, full log)',
      'String tester with per-symbol DFA trace and an ε-NFA cross-check; exhaustive DFA-vs-NFA equivalence check',
      'Sample automata, blank workspace, CSV export of both transition tables',
      'Automated Node test suite for the engine and the diagram renderer',
    ];
    const planned = [
      ['State explosion analysis', 'Plot the reachable DFA size against the 2ⁿ upper bound for each NFA size.'],
      ['DFA minimization', 'Hopcroft partition refinement or table-filling on the generated DFA.'],
      ['Language equivalence', 'Product construction on two automata with emptiness check of the symmetric difference.'],
      ['Pumping Lemma assistant', 'Interactive game: user proposes a split, the tool checks the three pumping conditions.'],
      ['React + TypeScript + Vite migration', 'Current modules (automata, diagram, app) map directly onto components and hooks.'],
      ['Edge editing in the diagram', 'Select an edge to edit its symbols or delete it.'],
    ];
    return `
      <div class="intro"><p>Status of the prototype against the milestone scope. Items marked planned are not implemented.</p></div>
      <div class="grid-2">
        <section class="panel">
          <header class="panel-head"><h2>Implemented in Milestone 1</h2></header>
          <ul class="checklist">${done.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
        </section>
        <section class="panel">
          <header class="panel-head"><h2>Planned for Milestone 2</h2></header>
          <table class="grid compact">
            <thead><tr><th>Module</th><th>Plan</th></tr></thead>
            <tbody>${planned.map(([m, p]) => `<tr><td><b>${esc(m)}</b></td><td>${esc(p)}</td></tr>`).join('')}</tbody>
          </table>
        </section>
      </div>`;
  }

  // ================================================================ rendering

  const VIEWS = {
    converter: viewConverter,
    steps: viewSteps,
    tester: viewTester,
    roadmap: viewRoadmap,
  };

  function mainHtml() {
    return VIEWS[app.tab]();
  }

  function render() {
    root.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="logo" aria-hidden="true">ε→D</div>
          <div>
            <h1>ε-NFA → DFA Conversion Simulator</h1>
            <p>Subset (power set) construction · Automata Theory &amp; Computability · Milestone 1 prototype</p>
          </div>
        </div>
        <nav class="tabs" role="tablist">
          ${TABS.map(([k, label]) => `<button class="tab ${app.tab === k ? 'active' : ''}" role="tab" data-action="tab" data-tab="${k}">${esc(label)}</button>`).join('')}
        </nav>
      </header>
      <div id="flash-slot">${flashHtml()}</div>
      <main id="main">${mainHtml()}</main>
      <footer class="footer">Runs entirely in your browser: no server, no dependencies. Core algorithm in <code>src/automata.js</code>, covered by the Node test suite.</footer>`;
  }

  function renderMain() {
    const el = document.getElementById('main');
    if (el) el.innerHTML = mainHtml();
  }

  function setSlot(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  /** Re-renders the derived parts of the converter without replacing the inputs being edited. */
  function refreshSlots(withTable) {
    if (withTable) setSlot('nfa-table', tableHtml());
    setSlot('nfa-diagram', diagramHtml());
    setSlot('validation', validationHtml());
    setSlot('conversion', conversionHtml());
  }

  // ================================================================ events

  const ACTIONS = {
    tab: (el) => {
      stopPlay();
      app.tab = el.dataset.tab;
    },
    'add-state': () => addState(),
    'del-state': (el) => removeState(app.nfa.states[+el.dataset.index]),
    'toggle-connect': () => {
      app.connect = app.connect ? null : { from: null, to: null };
    },
    'cancel-connect': () => {
      app.connect = null;
    },
    'pick-symbol': (el) => {
      const c = app.connect;
      if (c && c.from && c.to) addTransition(c.from, el.dataset.sym, c.to);
      app.connect = null;
    },
    convert: () => {
      app.showDFA = true;
    },
    'open-steps': () => {
      stopPlay();
      app.tab = 'steps';
      app.view = 'step';
      app.step = 0;
    },
    clear: () => loadSample(''),
    export: (el) => exportCsv(el.dataset.which),
    view: (el) => {
      app.view = el.dataset.view;
    },
    prev: () => setStep(app.step - 1),
    next: () => setStep(app.step + 1),
    goto: (el) => setStep(+el.dataset.step),
    play: () => togglePlay(),
    'reset-steps': () => {
      stopPlay();
      app.step = 0;
    },
    'run-test': () => runTest(),
    verify: () => runVerify(),
  };

  root.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const target = e.target;
    if (!target.closest) return;

    // Clicking a state while in "add transition" mode
    const nodeEl = target.closest('g.node[data-node]');
    if (nodeEl && app.connect && nodeEl.ownerSVGElement && nodeEl.ownerSVGElement.dataset.graph === 'nfa') {
      const id = nodeEl.dataset.node;
      const c = app.connect;
      if (!c.from || c.to) app.connect = { from: id, to: null };
      else app.connect = { from: c.from, to: id };
      refreshDiagram();
      return;
    }

    const el = target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    app.flash = '';
    fn(el);
    render();
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[name="initial"]')) {
      app.nfa.initial = app.nfa.states[+t.value];
    } else if (t.matches('input[data-final]')) {
      const s = app.nfa.states[+t.dataset.final];
      if (t.checked) {
        if (!app.nfa.finals.includes(s)) app.nfa.finals.push(s);
      } else {
        app.nfa.finals = app.nfa.finals.filter((x) => x !== s);
      }
    } else if (t.matches('select[data-sample-select]')) {
      loadSample(t.value);
    } else if (t.matches('select[data-verify-len]')) {
      app.verifyLen = +t.value;
      app.verifyResult = null;
    } else {
      return;
    }
    app.flash = '';
    render();
  });

  root.addEventListener('focusout', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.matches('input[data-rename]')) {
      commitRename(t);
    } else if (t.matches('input.cell')) {
      setCell(t.dataset.from, t.dataset.sym, t.value);
      refreshSlots(false);
    } else if (t.id === 'alphabet') {
      app.nfa.alphabet = A.parseList(t.value);
      refreshSlots(true);
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.id === 'test-input') {
      app.flash = '';
      runTest();
      render();
      return;
    }
    e.target.blur();
  });

  root.addEventListener('input', (e) => {
    if (e.target.id === 'test-input') app.testInput = e.target.value;
  });

  // Drag states to rearrange the ε-NFA diagram.
  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const vb = svg.viewBox.baseVal;
    return {
      x: Math.max(40, Math.min(vb.width - 40, p.x)),
      y: Math.max(40, Math.min(vb.height - 40, p.y)),
    };
  }

  root.addEventListener('pointerdown', (e) => {
    const node = e.target.closest && e.target.closest('g.node[data-node]');
    if (!node || !node.ownerSVGElement || node.ownerSVGElement.dataset.graph !== 'nfa') return;
    drag = { id: node.dataset.node, svg: node.ownerSVGElement, x: e.clientX, y: e.clientY, moved: false };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    app.pos[drag.id] = svgPoint(drag.svg, e);
    refreshDiagram();
  });

  window.addEventListener('pointerup', () => {
    if (drag && drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 300);
    }
    drag = null;
  });

  // ================================================================ start

  render();
})();
