'use strict';

// modBrowser against stubbed registry clients: per-platform result shaping for
// Hangar/Spiget/Modrinth/CurseForge, and the required-dependency closure
// (dedupe, cycles, per-platform isolation, safety caps, skipped-dependency warnings).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const modrinth = require('../src/services/modrinthApi');
const curseforge = require('../src/services/curseforgeApi');
const hangar = require('../src/services/hangarApi');
const spiget = require('../src/services/spigetApi');
const modBrowser = require('../src/services/modBrowser');

const seen = {};
function record(name, fn) {
  return async (...args) => {
    (seen[name] ||= []).push(args);
    return fn(...args);
  };
}

test('search: a blank query short-circuits with no registry call', async () => {
  modrinth.search = record('mr.search', async () => {
    throw new Error('should not be called');
  });
  assert.deepEqual(await modBrowser.search({ query: '   ', platform: 'modrinth' }), []);
  assert.deepEqual(await modBrowser.search({}), []);
});

test('search: Modrinth results are shaped, and LATEST/SNAPSHOT means no MC filter', async () => {
  modrinth.search = record('mr.search', async () => [
    { slug: 'sodium', projectId: 'AANobbMI', title: 'Sodium', description: 'fast', iconUrl: 'i', downloads: 5 },
    { slug: 'bare', projectId: 'X', title: 'Bare' },
  ]);
  const out = await modBrowser.search({ query: 'sod', platform: 'modrinth', loader: 'fabric', mc: 'LATEST' });
  assert.deepEqual(out[0], {
    platform: 'modrinth',
    ref: 'sodium',
    projectId: 'AANobbMI',
    name: 'Sodium',
    description: 'fast',
    iconUrl: 'i',
    downloads: 5,
  });
  assert.deepEqual([out[1].description, out[1].iconUrl, out[1].downloads], ['', null, 0]);
  assert.equal(seen['mr.search'].at(-1)[0].mcVersion, undefined);
  assert.equal(seen['mr.search'].at(-1)[0].loader, 'fabric');
});

test('search: non-mod kinds never send a loader filter', async () => {
  await modBrowser.search({ query: 'x', platform: 'modrinth', kind: 'datapack', loader: 'fabric', mc: '1.21' });
  const args = seen['mr.search'].at(-1)[0];
  assert.equal(args.loader, undefined);
  assert.equal(args.mcVersion, '1.21');
});

test('search: Hangar, Spiget, and CurseForge results are shaped per platform', async () => {
  hangar.search = record('hg.search', async () => [{ slug: 'ess', name: 'Essentials', downloads: 9 }]);
  spiget.search = record('sp.search', async () => [{ resourceId: 42, name: 'Vault', tag: 'econ', external: true }]);
  curseforge.search = record('cf.search', async () => [{ slug: 'jei', modId: 238222, name: 'JEI', summary: 's' }]);
  const [h] = await modBrowser.search({ query: 'e', platform: 'hangar', kind: 'plugin' });
  assert.deepEqual([h.platform, h.ref, h.projectId, h.description], ['hangar', 'ess', 'ess', '']);
  const [s] = await modBrowser.search({ query: 'v', platform: 'spiget', kind: 'plugin' });
  assert.deepEqual([s.ref, s.projectId, s.description, s.external], ['42', '42', 'econ', true]);
  const [c] = await modBrowser.search({ query: 'j', platform: 'curseforge' });
  assert.deepEqual([c.ref, c.projectId, c.description], ['jei', '238222', 's']);
});

test('metaFor: id vs slug on CurseForge, and each platform shape', async () => {
  curseforge.getMod = record('cf.getMod', async (id) => ({ slug: 'jei', modId: id, name: 'JEI', iconUrl: 'u' }));
  curseforge.resolveUrl = record('cf.resolveUrl', async () => ({ slug: 'jei', modId: 1, name: 'JEI' }));
  assert.equal((await modBrowser.metaFor('curseforge', '238222')).projectId, '238222');
  assert.equal(seen['cf.getMod'].at(-1)[0], 238222, 'numeric ids look up by id');
  assert.equal((await modBrowser.metaFor('curseforge', 'jei', { kind: 'plugin' })).iconUrl, null);
  assert.deepEqual(seen['cf.resolveUrl'].at(-1), ['jei', { kind: 'plugin' }]);

  hangar.getProject = record('hg.get', async () => ({ slug: 'ess', name: 'Essentials' }));
  spiget.getResource = record('sp.get', async () => ({ resourceId: 7, name: 'Vault', iconUrl: 'i' }));
  modrinth.getProject = record('mr.get', async () => ({ slug: 'sodium', id: 'P1', title: 'Sodium', icon_url: 'ic' }));
  assert.deepEqual(await modBrowser.metaFor('hangar', 'ess'), {
    ref: 'ess',
    projectId: 'ess',
    name: 'Essentials',
    iconUrl: null,
  });
  assert.equal((await modBrowser.metaFor('spiget', 7)).projectId, '7');
  assert.deepEqual(await modBrowser.metaFor('modrinth', 'sodium'), {
    ref: 'sodium',
    projectId: 'P1',
    name: 'Sodium',
    iconUrl: 'ic',
  });
});

test('versions: Modrinth builds are normalised with required-dependency ids only', async () => {
  modrinth.getVersions = record('mr.versions', async () => [
    {
      id: 'v1',
      name: 'Sodium 1.0',
      version_number: '1.0',
      game_versions: ['1.21'],
      dependencies: [
        { dependency_type: 'required', project_id: 'A' },
        { dependency_type: 'optional', project_id: 'B' },
        { dependency_type: 'required' },
      ],
    },
    { id: 'v2', version_number: '0.9' },
  ]);
  const out = await modBrowser.versions({ platform: 'modrinth', ref: 'sodium', loader: 'fabric', mc: '1.21' });
  assert.deepEqual(out[0].requiredDeps, ['A']);
  assert.equal(out[1].name, '0.9', 'falls back to the version number');
  assert.equal(out[1].versionType, 'release');
  assert.equal((await modBrowser.versions({ platform: 'modrinth', ref: 'x', limit: 1 })).length, 1);
});

test('versions: Hangar flags downloadability, Spiget passes through, CurseForge maps relation 3', async () => {
  hangar.getVersions = record('hg.versions', async () => [
    { versionId: 'h1', name: 'n', versionNumber: '1', versionType: 'release', gameVersions: [], downloadUrl: 'u' },
    { versionId: 'h2', name: 'n', versionNumber: '2', versionType: 'release', gameVersions: [] },
  ]);
  const h = await modBrowser.versions({ platform: 'hangar', ref: 'ess', kind: 'plugin' });
  assert.deepEqual([h[0].downloadable, h[1].downloadable, h[0].requiredDeps], [true, false, []]);

  spiget.getVersions = record('sp.versions', async () => [{ versionId: 's1' }, { versionId: 's2' }]);
  assert.equal((await modBrowser.versions({ platform: 'spiget', ref: '7', limit: 1 })).length, 1);

  curseforge.getFiles = record('cf.files', async () => [
    {
      fileId: 9,
      fileName: 'jei.jar',
      downloadUrl: 'u',
      dependencies: [
        { relation: 3, modId: 11 },
        { relation: 2, modId: 12 },
      ],
    },
  ]);
  const c = await modBrowser.versions({ platform: 'curseforge', ref: '238222', loader: 'forge', mc: '1.20.1' });
  assert.deepEqual([c[0].versionId, c[0].requiredDeps, c[0].downloadable], ['9', ['11'], true]);
});

// ---- resolveDependencies -----------------------------------------------------

/** Install a tiny in-memory Modrinth registry: { projectId: { versions: [{id, deps:[projectIds]}] } }. */
function registry(projects) {
  modrinth.getProject = async (ref) => {
    const id = Object.keys(projects).find((k) => k === ref || projects[k].slug === ref);
    if (!id) throw new Error('404');
    return { slug: projects[id].slug || id.toLowerCase(), id, title: `Mod ${id}`, icon_url: null };
  };
  modrinth.getVersions = async (ref) => {
    const id = Object.keys(projects).find((k) => k === ref || projects[k].slug === ref || k.toLowerCase() === ref);
    return (projects[id].versions || []).map((v) => ({
      id: v.id,
      version_number: v.id,
      dependencies: (v.deps || []).map((p) => ({ dependency_type: 'required', project_id: p })),
    }));
  };
  modrinth.getVersion = async (versionId) => {
    for (const p of Object.values(projects)) {
      const v = (p.versions || []).find((x) => x.id === versionId);
      if (v) {
        return {
          id: v.id,
          version_number: v.id,
          dependencies: (v.deps || []).map((d) => ({ dependency_type: 'required', project_id: d })),
        };
      }
    }
    throw new Error('404 version');
  };
}

test('resolveDependencies: follows the required closure, newest build first, excluding the selection', async () => {
  registry({
    A: { versions: [{ id: 'a1', deps: ['B', 'C'] }] },
    B: { versions: [{ id: 'b2', deps: ['D'] }, { id: 'b1' }] },
    C: { versions: [{ id: 'c1', deps: ['D'] }] },
    D: { versions: [{ id: 'd1' }] },
  });
  const out = await modBrowser.resolveDependencies({
    loader: 'fabric',
    mc: '1.21',
    selection: [{ platform: 'modrinth', ref: 'A', versionId: 'a1' }],
  });
  assert.deepEqual(out.deps.map((d) => d.projectId).sort(), ['B', 'C', 'D']);
  const b = out.deps.find((d) => d.projectId === 'B');
  assert.equal(b.versionId, 'b2');
  assert.equal(b.versions.length, 2);
  assert.deepEqual(out.warnings, []);
});

test('resolveDependencies: cycles terminate and a selected mod is never re-added as a dependency', async () => {
  registry({
    A: { versions: [{ id: 'a1', deps: ['B'] }] },
    B: { versions: [{ id: 'b1', deps: ['A'] }] },
  });
  const out = await modBrowser.resolveDependencies({
    loader: 'fabric',
    selection: [{ platform: 'modrinth', ref: 'A', versionId: 'a1' }],
  });
  assert.deepEqual(
    out.deps.map((d) => d.projectId),
    ['B']
  );
});

test('resolveDependencies: a dependency with no compatible build is skipped with a warning', async () => {
  registry({
    A: { versions: [{ id: 'a1', deps: ['B'] }] },
    B: { versions: [] },
  });
  const out = await modBrowser.resolveDependencies({
    loader: 'forge',
    mc: '1.20.1',
    selection: [{ platform: 'modrinth', ref: 'A', versionId: 'a1' }],
  });
  assert.equal(out.deps.length, 0);
  assert.deepEqual(out.warnings, ['Mod B has no forge 1.20.1 build - skipped']);
});

test('resolveDependencies: unknown projects, missing versions, and junk selections never throw', async () => {
  registry({ A: { versions: [{ id: 'a1', deps: ['GHOST'] }] } });
  const out = await modBrowser.resolveDependencies({
    loader: 'fabric',
    selection: [
      null,
      { platform: 'modrinth' },
      { platform: 'modrinth', ref: 'NOPE', versionId: 'x' },
      { platform: 'modrinth', ref: 'A', versionId: 'a1' },
      { platform: 'modrinth', ref: 'A', versionId: 'missing-version' },
    ],
  });
  assert.deepEqual(out.deps, []);
});

test('resolveDependencies: Hangar and Spiget selections have no dependency data', async () => {
  hangar.getProject = async () => ({ slug: 'ess', name: 'Essentials' });
  spiget.getResource = async () => ({ resourceId: 7, name: 'Vault' });
  const out = await modBrowser.resolveDependencies({
    loader: 'paper',
    selection: [
      { platform: 'hangar', ref: 'ess', versionId: 'h1' },
      { platform: 'spiget', ref: '7', versionId: 's1' },
    ],
  });
  assert.deepEqual(out, { deps: [], warnings: [] });
});

test('resolveDependencies: CurseForge deps are resolved by file relation', async () => {
  curseforge.getMod = async (id) => ({ slug: `mod-${id}`, modId: id, name: `CF ${id}` });
  curseforge.getFile = async (modId) => ({
    fileId: 1,
    dependencies: modId === 100 ? [{ relation: 3, modId: 200 }] : [],
  });
  curseforge.getFiles = async () => [{ fileId: 5, fileName: 'dep.jar', dependencies: [] }];
  const out = await modBrowser.resolveDependencies({
    loader: 'forge',
    mc: '1.20.1',
    selection: [{ platform: 'curseforge', ref: '100', versionId: '1' }],
  });
  assert.deepEqual(
    out.deps.map((d) => [d.projectId, d.versionId]),
    [['200', '5']]
  );
});

test('resolveDependencies: the closure is capped so a huge tree cannot run away', async () => {
  const projects = { ROOT: { versions: [{ id: 'r1', deps: [] }] } };
  const kids = Array.from({ length: 80 }, (_, i) => `K${i}`);
  projects.ROOT.versions[0].deps = kids;
  for (const k of kids) projects[k] = { versions: [{ id: `${k}v` }] };
  registry(projects);
  const out = await modBrowser.resolveDependencies({
    loader: 'fabric',
    selection: [{ platform: 'modrinth', ref: 'ROOT', versionId: 'r1' }],
  });
  assert.equal(out.deps.length, 50);
});
