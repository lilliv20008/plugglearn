'use strict';
const sim = require('./sim');
const chaoxing = require('./chaoxing');
const chaoxingBrowser = require('./chaoxing-browser');

const registry = new Map([
  [sim.id, sim],
  [chaoxing.id, chaoxing],
  [chaoxingBrowser.id, chaoxingBrowser],
]);

function get(id) {
  return registry.get(id) || sim;
}

module.exports = { get, list: () => [...registry.values()].map((p) => ({ id: p.id, label: p.label })) };