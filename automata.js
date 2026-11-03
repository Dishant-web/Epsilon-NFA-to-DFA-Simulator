/**
 * automata.js
 * Pure, UI-independent model of an ε-NFA and the subset (power set) construction.
 * Exposed as window.Automata in the browser and as module.exports in Node (tests).
 *
 * Automaton shape:
 *   {
 *     states:      string[],                 // Q
 *     alphabet:    string[],                 // Σ (ε is never a member)
 *     initial:     string | null,            // q0
 *     finals:      string[],                 // F
 *     transitions: { [state]: { [symbol | 'ε']: string[] } }   // δ
 *   }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Automata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 'ε';
  const EMPTY_LABEL = '∅';

  const byName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  const uniqueSorted = (xs) => [...new Set(xs)].sort(byName);
  const duplicates = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i).filter((x, i, arr) => arr.indexOf(x) === i);

  // ---------------------------------------------------------------- model helpers

  function newAutomaton(init = {}) {
    return { states: [], alphabet: [], initial: null, finals: [], transitions: {}, ...init };
  }

  function cloneAutomaton(nfa) {
    return JSON.parse(JSON.stringify(nfa));
  }

  /** Splits user text such as "q1, q2" or "a b" into tokens. */
  function parseList(text) {
    return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }

  function isValidStateName(name) {
    return /^[A-Za-z_][A-Za-z0-9_']{0,11}$/.test(name);
  }

  function isValidSymbol(sym) {
    return typeof sym === 'string' && sym.length === 1 && sym !== EPS && /^[^\s,{}()]$/.test(sym);
  }

  function getTargets(nfa, state, symbol) {
    const row = nfa.transitions[state];
    return row && row[symbol] ? row[symbol] : [];
  }

  /** Replaces the destination list δ(state, symbol); an empty list removes the transition. */
  function setTargets(nfa, state, symbol, targets) {
    const clean = uniqueSorted(targets);
    const row = nfa.transitions[state];
    if (clean.length === 0) {
      if (row) {
        delete row[symbol];
        if (Object.keys(row).length === 0) delete nfa.transitions[state];
      }
    } else {
      if (!row) nfa.transitions[state] = {};
      nfa.transitions[state][symbol] = clean;
    }
    return nfa;
  }

  function subsetLabel(members) {
    return members.length ? '{' + members.join(', ') + '}' : EMPTY_LABEL;
  }

  // ---------------------------------------------------------------- core operations

  /** ε-closure: every state reachable from `states` using only ε-transitions (handles cycles). */
  function epsilonClosure(nfa, states) {
    const seen = new Set(states);
    const stack = [...seen];
    while (stack.length > 0) {
      const s = stack.pop();
      for (const t of getTargets(nfa, s, EPS)) {
        if (!seen.has(t)) {
          seen.add(t);
          stack.push(t);
        }
      }
    }
    return uniqueSorted([...seen]);
  }

  /** move(S, a): all states reachable from S by exactly one a-transition (no ε). */
  function move(nfa, states, symbol) {
    const out = new Set();
    for (const s of states) for (const t of getTargets(nfa, s, symbol)) out.add(t);
    return uniqueSorted([...out]);
  }

  // ---------------------------------------------------------------- validation

  function validate(nfa) {
    const errors = [];
    const push = (msg) => { if (!errors.includes(msg)) errors.push(msg); };
    const { states, alphabet, initial, finals, transitions } = nfa;

    if (states.length === 0) push('Define at least one state.');
    for (const dup of duplicates(states)) push(`Duplicate state identifier "${dup}".`);
    for (const s of states) {
      if (!isValidStateName(s)) {
        push(`Invalid state name "${s}": use letters, digits, "_" or "'", starting with a letter or "_" (max 12 characters).`);
      }
    }

    if (alphabet.length === 0) push('Define at least one input symbol.');
    for (const dup of duplicates(alphabet)) push(`Duplicate input symbol "${dup}".`);
    for (const sym of alphabet) {
      if (sym === EPS) push('"ε" is reserved for ε-transitions and cannot be an input symbol.');
      else if (!isValidSymbol(sym)) push(`Invalid input symbol "${sym}": each symbol must be a single visible character.`);
    }

    if (initial === null || initial === undefined || initial === '') push('Select an initial state.');
    else if (!states.includes(initial)) push(`Initial state "${initial}" is not a defined state.`);

    for (const f of finals) {
      if (!states.includes(f)) push(`Final state "${f}" is not a defined state.`);
    }

    for (const from of Object.keys(transitions)) {
      if (!states.includes(from)) push(`Transitions are defined from undefined state "${from}".`);
      for (const sym of Object.keys(transitions[from])) {
        if (sym !== EPS && !alphabet.includes(sym)) {
          push(`Symbol "${sym}" used from ${from} is not in the input alphabet.`);
        }
        const targets = transitions[from][sym];
        if (!targets || targets.length === 0) push(`Empty destination list for ${from} on "${sym}".`);
        for (const to of targets || []) {
          if (!states.includes(to)) push(`Transition ${from} --${sym}--> ${to} points to undefined state "${to}".`);
        }
      }
    }
    return errors;
  }

  // ---------------------------------------------------------------- subset construction

  /**
   * Subset (power set) construction with a worklist.
   * Only reachable subsets become DFA states. Subsets are canonical (sorted member lists),
   * so each distinct subset is created exactly once. The empty subset becomes an explicit
   * trap state, which receives a self-loop on every symbol.
   *
   * Returns { dfa, trace }. `trace` is the ordered list of atomic steps that produced dfa.
   */
  function subsetConstruction(nfa) {
    const errors = validate(nfa);
    if (errors.length) {
      const err = new Error('Invalid automaton: ' + errors.join(' '));
      err.errors = errors;
      throw err;
    }

    const dfa = { states: [], alphabet: [...nfa.alphabet], initial: null, finals: [], transitions: {} };
    const byKey = new Map();
    const trace = [];
    const queue = [];
    const finalSet = new Set(nfa.finals);
    const L = subsetLabel;
    const acceptingOf = (members) => members.filter((s) => finalSet.has(s));
    const stateOf = (id) => dfa.states.find((s) => s.id === id);
    const alphaText = '{' + nfa.alphabet.join(', ') + '}';

    function register(members) {
      const id = 'D' + dfa.states.length;
      const st = {
        id,
        members,
        label: L(members),
        initial: false,
        accepting: members.some((s) => finalSet.has(s)),
        trap: members.length === 0,
      };
      dfa.states.push(st);
      byKey.set(members.join('\u0001'), id);
      return st;
    }

    // Step 1: initial ε-closure
    const startSet = epsilonClosure(nfa, [nfa.initial]);
    const start = register(startSet);
    start.initial = true;
    dfa.initial = start.id;
    queue.push(start.id);
    trace.push({
      type: 'start',
      id: start.id,
      members: startSet,
      accepting: start.accepting,
      trap: false,
      short: `S₀ = ε-closure({${nfa.initial}}) = ${L(startSet)}`,
      text:
        `Initial DFA state ${start.id} = ε-closure({${nfa.initial}}) = ${L(startSet)}. ` +
        (start.accepting
          ? `It contains final NFA state(s) ${acceptingOf(startSet).join(', ')}, so it is accepting.`
          : 'It contains no final NFA state, so it is non-accepting.'),
    });

    // Steps 2..n: process worklist
    while (queue.length > 0) {
      const sid = queue.shift();
      const src = stateOf(sid);
      const S = src.members;
      dfa.transitions[sid] = {};

      trace.push({
        type: 'process',
        id: sid,
        members: S,
        trap: src.trap,
        short: `Process ${sid} = ${src.label}`,
        text: src.trap
          ? `${sid} = ∅ is the empty subset: a trap (dead) state. Every symbol leads back to ∅, so it gets a self-loop on each symbol of Σ = ${alphaText}.`
          : `Process ${sid} = ${src.label}. For each symbol of Σ = ${alphaText}, compute move(${src.label}, a) and then its ε-closure.`,
      });

      for (const a of nfa.alphabet) {
        // Step: move
        const M = move(nfa, S, a);
        trace.push({
          type: 'move',
          from: sid,
          symbol: a,
          members: S,
          move: M,
          short: `move(${sid}, ${a}) = ${L(M)}`,
          text:
            `move(${src.label}, ${a}) = ${L(M)}: ` +
            (M.length
              ? `the union of the ${a}-destinations of every NFA state in the subset.`
              : `no NFA state in the subset has a ${a}-transition, so the result is ∅.`),
        });

        // Step: ε-closure of the move
        const T = M.length ? epsilonClosure(nfa, M) : [];
        trace.push({
          type: 'closure',
          from: sid,
          symbol: a,
          move: M,
          closure: T,
          members: M,
          short: `ε-closure(${L(M)}) = ${L(T)}`,
          text:
            `ε-closure(${L(M)}) = ${L(T)}` +
            (M.length ? ' (adds every state reachable through ε-transitions).' : ' (the ε-closure of ∅ is ∅).'),
        });

        // Step: identify or create the target DFA state
        const key = T.join('\u0001');
        const isNew = !byKey.has(key);
        if (isNew) {
          const st = register(T);
          queue.push(st.id);
          let text;
          if (st.trap) {
            text = `${L(T)} = ∅ is a new subset, so it becomes ${st.id}. It is the empty subset: no NFA state can be reached from here, so it is the explicit trap (dead) state.`;
          } else if (st.accepting) {
            text = `${st.label} is a new subset, so it becomes ${st.id}. It contains final NFA state(s) ${acceptingOf(T).join(', ')}, so it is accepting.`;
          } else {
            text = `${st.label} is a new subset, so it becomes ${st.id}. It contains no final NFA state, so it is non-accepting.`;
          }
          trace.push({
            type: 'discover',
            id: st.id,
            members: T,
            accepting: st.accepting,
            trap: st.trap,
            short: `New state ${st.id} = ${st.label}`,
            text,
          });
        }
        const to = byKey.get(key);

        // Step: add the transition
        dfa.transitions[sid][a] = to;
        trace.push({
          type: 'transition',
          from: sid,
          symbol: a,
          to,
          isNew,
          move: M,
          closure: T,
          members: T,
          short: `δ(${sid}, ${a}) = ${to}`,
          text:
            `Add δ(${sid}, ${a}) = ${to}` +
            (isNew
              ? ` (the newly created state ${to}).`
              : ` (${to} = ${stateOf(to).label} already exists, so it is reused: each subset maps to exactly one DFA state).`),
        });
      }
    }

    dfa.finals = dfa.states.filter((s) => s.accepting).map((s) => s.id);
    const hasTrap = dfa.states.some((s) => s.trap);
    const finalsText = dfa.states.filter((s) => s.accepting).map((s) => `${s.id} ${s.label}`).join(', ') || 'none';
    trace.push({
      type: 'complete',
      count: dfa.states.length,
      short: 'Construction complete',
      text:
        `Construction complete: ${dfa.states.length} reachable DFA states. Accepting: ${finalsText}. ` +
        (hasTrap
          ? 'The trap state is included, with a self-loop on every symbol.'
          : 'No trap state was needed, because every reachable subset is non-empty.'),
    });

    return { dfa, trace };
  }

  // ---------------------------------------------------------------- simulation & verification

  /** Runs a string through the DFA, recording each transition. */
  function runDFA(dfa, input) {
    const steps = [];
    let current = dfa.initial;
    for (let i = 0; i < input.length; i++) {
      const sym = input[i];
      if (!dfa.alphabet.includes(sym)) {
        return { accepted: false, steps, error: `Symbol "${sym}" (position ${i + 1}) is not in the alphabet.`, final: current };
      }
      const next = dfa.transitions[current][sym];
      steps.push({ position: i + 1, symbol: sym, from: current, to: next });
      current = next;
    }
    return { accepted: dfa.finals.includes(current), steps, error: null, final: current };
  }

  /** Independent ε-NFA simulation, used to cross-check the DFA. */
  function nfaAccepts(nfa, input) {
    let current = epsilonClosure(nfa, [nfa.initial]);
    for (const sym of input) {
      if (!nfa.alphabet.includes(sym)) return false;
      current = epsilonClosure(nfa, move(nfa, current, sym));
    }
    return current.some((s) => nfa.finals.includes(s));
  }

  /** Compares the DFA with the ε-NFA on every string of length 0..maxLength. */
  function verifyEquivalence(nfa, dfa, maxLength) {
    let tested = 0;
    let mismatchCount = 0;
    const mismatches = [];
    let layer = [''];
    for (let len = 0; len <= maxLength; len++) {
      for (const word of layer) {
        tested++;
        const viaNfa = nfaAccepts(nfa, word);
        const viaDfa = runDFA(dfa, word).accepted;
        if (viaNfa !== viaDfa) {
          mismatchCount++;
          if (mismatches.length < 10) mismatches.push({ input: word, nfa: viaNfa, dfa: viaDfa });
        }
      }
      if (len < maxLength) layer = layer.flatMap((w) => nfa.alphabet.map((c) => w + c));
    }
    return { maxLength, tested, mismatchCount, mismatches, equivalent: mismatchCount === 0 };
  }

  // ---------------------------------------------------------------- sample automata

  const SAMPLES = {
    textbook: {
      label: 'Textbook ε-NFA (cycle + multiple destinations)',
      description:
        'Four states. q0 starts an ε-chain into the ε-cycle q1 ⇄ q2, q1 on a goes to {q2, q3}, and q3 is final. ' +
        'The resulting DFA accepts every non-empty string over {a, b}.',
      nfa: newAutomaton({
        states: ['q0', 'q1', 'q2', 'q3'],
        alphabet: ['a', 'b'],
        initial: 'q0',
        finals: ['q3'],
        transitions: {
          q0: { 'ε': ['q1'] },
          q1: { 'ε': ['q2'], a: ['q2', 'q3'], b: ['q3'] },
          q2: { 'ε': ['q1'], b: ['q0'] },
        },
      }),
    },
    trap: {
      label: 'Language {a} (explicit trap state)',
      description:
        'Accepts exactly the string "a". Every other move produces the empty subset, which becomes an explicit trap state.',
      nfa: newAutomaton({
        states: ['q0', 'q1'],
        alphabet: ['a', 'b'],
        initial: 'q0',
        finals: ['q1'],
        transitions: {
          q0: { a: ['q1'] },
        },
      }),
    },
    acceptingStart: {
      label: 'Accepting start + ε-path (two finals)',
      description:
        'The initial state q0 is accepting and reaches q1 by an ε-transition. Two final states exist, and the DFA gets a trap state after the b-move from {q2}.',
      nfa: newAutomaton({
        states: ['q0', 'q1', 'q2'],
        alphabet: ['a', 'b'],
        initial: 'q0',
        finals: ['q0', 'q2'],
        transitions: {
          q0: { 'ε': ['q1'] },
          q1: { a: ['q2'], b: ['q0'] },
          q2: { a: ['q2'] },
        },
      }),
    },
  };

  return {
    EPS,
    EMPTY_LABEL,
    newAutomaton,
    cloneAutomaton,
    parseList,
    isValidStateName,
    isValidSymbol,
    getTargets,
    setTargets,
    epsilonClosure,
    move,
    subsetLabel,
    validate,
    subsetConstruction,
    runDFA,
    nfaAccepts,
    verifyEquivalence,
    SAMPLES,
  };
});
