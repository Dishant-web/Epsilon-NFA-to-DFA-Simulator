/**
 * diagram.js
 * Dependency-free SVG renderer for automaton graphs.
 * Produces strings only (no DOM access), so it can be unit-tested in Node.
 *
 * Graph shape:
 *   nodes: [{ id, label, sub?, initial?, final?, trap? }]
 *   edges: [{ from, to, labels: [{ text, eps }] }]   // parallel edges are grouped by the caller
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Diagram = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 'ε';
  const HALF_H = 22;
  const CHAR_W = 7.6;
  const DEFAULT_WIDTH = 720;
  const DEFAULT_HEIGHT = 480;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /** Half the rendered width of a node, so pill shapes fit their label. */
  function halfWidth(node) {
    const chars = Math.max(String(node.label).length, String(node.sub || '').length * 0.8);
    return Math.max(34, (chars * CHAR_W + 22) / 2);
  }

  /** Circular default layout; positions already known (e.g. dragged) are kept. */
  function layout(nodes, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, existing) {
    const known = existing || {};
    const positions = {};
    const n = nodes.length;
    const cx = width / 2;
    const cy = height / 2 + 10;
    const radius = Math.max(60, Math.min(width / 2 - 150, height / 2 - 100));
    nodes.forEach((node, i) => {
      if (known[node.id]) {
        positions[node.id] = { x: known[node.id].x, y: known[node.id].y };
      } else if (n === 1) {
        positions[node.id] = { x: cx, y: cy };
      } else {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
        positions[node.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      }
    });
    return positions;
  }

  /** Distance from a rectangle's centre to its border along direction (ux, uy). */
  function boundary(hw, hh, ux, uy) {
    const tx = Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity;
    const ty = Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity;
    return Math.min(tx, ty);
  }

  function renderGraph(graph, opts) {
    const o = opts || {};
    const width = o.width || DEFAULT_WIDTH;
    const height = o.height || DEFAULT_HEIGHT;
    const kind = o.kind || 'graph';
    const pre = o.idPrefix || kind;
    const nodes = (graph.nodes || []).map((n) => ({ ...n, hw: halfWidth(n) }));
    const positions = layout(nodes, width, height, o.positions);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hiNodes = new Set(o.highlightNodes || []);
    const hiEdge = o.highlightEdge || null;
    const edges = (graph.edges || []).filter(
      (e) => byId.has(e.from) && byId.has(e.to) && e.labels && e.labels.length > 0
    );
    const pairs = new Set(edges.map((e) => e.from + '\u0001' + e.to));
    const parts = [];

    parts.push(
      `<defs>` +
      `<marker id="${pre}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>` +
      `<marker id="${pre}-arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrow arrow-hi"/></marker>` +
      `</defs>`
    );

    for (const e of edges) {
      const active = !!hiEdge && hiEdge.from === e.from && hiEdge.to === e.to;
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      const p1 = positions[e.from];
      const p2 = positions[e.to];
      const hasEps = e.labels.some((l) => l.eps);
      let d;
      let lx;
      let ly;

      if (e.from === e.to) {
        // self-loop drawn as an arc above the node
        const top = p1.y - HALF_H;
        const k = Math.max(20, a.hw * 0.4);
        d = `M${p1.x - k},${top} C${p1.x - k - 26},${top - 74} ${p1.x + k + 26},${top - 74} ${p1.x + k},${top}`;
        lx = p1.x;
        ly = top - 56;
      } else {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const t1 = boundary(a.hw, HALF_H, ux, uy);
        const t2 = boundary(b.hw, HALF_H, ux, uy);
        const sx = p1.x + ux * t1;
        const sy = p1.y + uy * t1;
        const ex = p2.x - ux * t2;
        const ey = p2.y - uy * t2;

        if (pairs.has(e.to + '\u0001' + e.from)) {
          // opposite edge exists: curve both so they do not overlap
          const cx = (sx + ex) / 2 - uy * 34;
          const cy = (sy + ey) / 2 + ux * 34;
          d = `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
          lx = 0.25 * sx + 0.5 * cx + 0.25 * ex;
          ly = 0.25 * sy + 0.5 * cy + 0.25 * ey;
        } else {
          d = `M${sx},${sy} L${ex},${ey}`;
          lx = (sx + ex) / 2;
          ly = (sy + ey) / 2 - 9;
        }
      }

      const text = e.labels
        .map((l) => (l.eps ? `<tspan class="eps">${EPS}</tspan>` : escapeHtml(l.text)))
        .join(', ');
      const cls = 'edge' + (active ? ' edge-active' : '') + (hasEps ? ' edge-eps' : '');
      parts.push(
        `<g class="${cls}">` +
        `<path class="edge-path" d="${d}" marker-end="url(#${pre}-arrow${active ? '-hi' : ''})"/>` +
        `<text class="edge-label" x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle">${text}</text>` +
        `</g>`
      );
    }

    for (const n of nodes) {
      const p = positions[n.id];
      const cls = ['node', n.trap ? 'node-trap' : '', hiNodes.has(n.id) ? 'node-active' : ''].filter(Boolean).join(' ');
      let g = `<g class="${cls}" data-node="${escapeHtml(n.id)}">`;
      if (n.initial) {
        g += `<line class="init-arrow" x1="${p.x - n.hw - 40}" y1="${p.y}" x2="${p.x - n.hw - 2}" y2="${p.y}" marker-end="url(#${pre}-arrow)"/>`;
      }
      if (n.final) {
        g += `<rect class="node-ring" x="${p.x - n.hw - 5}" y="${p.y - HALF_H - 5}" width="${2 * n.hw + 10}" height="${2 * HALF_H + 10}" rx="${HALF_H + 5}"/>`;
      }
      g += `<rect class="node-shape" x="${p.x - n.hw}" y="${p.y - HALF_H}" width="${2 * n.hw}" height="${2 * HALF_H}" rx="${HALF_H}"/>`;
      g += `<text class="node-label" x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central">${escapeHtml(n.label)}</text>`;
      if (n.sub) {
        g += `<text class="node-sub" x="${p.x}" y="${p.y + HALF_H + 17 + (n.final ? 4 : 0)}" text-anchor="middle">${escapeHtml(n.sub)}</text>`;
      }
      g += `</g>`;
      parts.push(g);
    }

    const svg =
      `<svg class="graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `data-graph="${escapeHtml(kind)}" role="img" aria-label="${escapeHtml(o.label || 'Automaton diagram')}">` +
      parts.join('') +
      `</svg>`;
    return { svg, positions };
  }

  return { escapeHtml, layout, renderGraph, DEFAULT_WIDTH, DEFAULT_HEIGHT };
});
