'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSlim } = require('../src/core/slim');

function dump(opts = {}) {
  return {
    meta: {
      gameLabel: 'Brilliant Diamond / Shining Pearl',
      platform: 'Switch',
      extractedAt: '2026-08-06T12:00:00.000Z',
    },
    party: [
      { species: 394, speciesName: 'Prinplup', nickname: 'Pingo', level: 31, shiny: false },
      { species: 1, speciesName: 'Bulbasaur', nickname: 'Bulby', level: 5, shiny: true },
    ],
    nuzlocke: { deadBox: { index: 17, name: 'Muertos', count: 5 } },
    ...opts,
  };
}

test('buildSlim arma _id compuesto player::nuzlocke', () => {
  const s = buildSlim(dump(), 'leo', 'con-amigos');
  assert.equal(s._id, 'leo::con-amigos');
  assert.equal(s.player, 'leo');
  assert.equal(s.nuzlocke, 'con-amigos');
});

test('buildSlim recorta espacios en player y nuzlocke', () => {
  const s = buildSlim(dump(), '  leo ', ' con-amigos ');
  assert.equal(s._id, 'leo::con-amigos');
});

test('buildSlim mapea solo los 5 campos de cada Pokémon del equipo', () => {
  const s = buildSlim(dump(), 'leo', 'x');
  assert.equal(s.party.length, 2);
  assert.deepEqual(s.party[0], {
    species: 394, speciesName: 'Prinplup', nickname: 'Pingo', level: 31, shiny: false,
  });
  assert.deepEqual(s.party[1], {
    species: 1, speciesName: 'Bulbasaur', nickname: 'Bulby', level: 5, shiny: true,
  });
  // no filtra campos extra que vengan en el dump: el slim sólo expone 5.
  const extra = buildSlim(
    { meta: {}, party: [{ species: 5, speciesName: 'C', nickname: 'N', level: 1, shiny: false, ivs: {}, evs: {} }] },
    'a', 'b',
  );
  assert.deepEqual(Object.keys(extra.party[0]).sort(), ['level', 'nickname', 'shiny', 'species', 'speciesName']);
});

test('buildSlim toma deadCount desde nuzlocke.deadBox.count', () => {
  assert.equal(buildSlim(dump(), 'a', 'b').deadCount, 5);
  assert.equal(buildSlim(dump({ nuzlocke: { deadBox: null } }), 'a', 'b').deadCount, 0);
  assert.equal(buildSlim(dump({ nuzlocke: {} }), 'a', 'b').deadCount, 0);
  assert.equal(buildSlim(dump({ nuzlocke: undefined }), 'a', 'b').deadCount, 0);
});

test('buildSlim copia gameLabel y platform como datos informativos', () => {
  const s = buildSlim(dump(), 'leo', 'con-amigos');
  assert.equal(s.gameLabel, 'Brilliant Diamond / Shining Pearl');
  assert.equal(s.platform, 'Switch');
});

test('buildSlim usa extractedAt como updatedAt', () => {
  const s = buildSlim(dump(), 'leo', 'con-amigos');
  assert.equal(s.updatedAt, '2026-08-06T12:00:00.000Z');
});

test('buildSlim sobrevive a dump sin party', () => {
  const s = buildSlim({ meta: { gameLabel: 'G', platform: 'Switch', extractedAt: 't' } }, 'a', 'b');
  assert.deepEqual(s.party, []);
  assert.equal(s.deadCount, 0);
});
