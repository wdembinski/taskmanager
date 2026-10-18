/**
 * Collected by the root `vitest.config.ts` the same way `shotChecks.test.mjs` is — no
 * `include` glob change needed for a `.mjs` suite next to a `.mjs` module.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listModuleFiles,
  loadFixtureChannels,
  loadScreens,
  mergeChannels,
  mergeScreens,
} from './shotModules.mjs';

describe('listModuleFiles', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('sorts *.mjs files by name and skips *.test.mjs', () => {
    dir = mkdtempSync(join(tmpdir(), 'shot-modules-'));
    writeFileSync(join(dir, '020-b.mjs'), 'export default [];\n');
    writeFileSync(join(dir, '010-a.mjs'), 'export default [];\n');
    writeFileSync(join(dir, '010-a.test.mjs'), '');
    writeFileSync(join(dir, 'notes.txt'), '');

    const files = listModuleFiles(dir).map((p) => basename(p));

    expect(files).toEqual(['010-a.mjs', '020-b.mjs']);
  });
});

describe('mergeScreens', () => {
  it('orders rows by file, then row', () => {
    const modules = [
      { file: '010-a.mjs', rows: [{ name: 'a1' }, { name: 'a2' }] },
      { file: '020-b.mjs', rows: [{ name: 'b1' }] },
    ];

    expect(mergeScreens(modules).map((r) => r.name)).toEqual(['a1', 'a2', 'b1']);
  });

  it('throws on a duplicate name across two files, naming both', () => {
    const modules = [
      { file: '010-a.mjs', rows: [{ name: 'dup' }] },
      { file: '020-b.mjs', rows: [{ name: 'dup' }] },
    ];

    expect(() => mergeScreens(modules)).toThrow(/010-a\.mjs/);
    expect(() => mergeScreens(modules)).toThrow(/020-b\.mjs/);
  });

  it('throws on a duplicate name within one file', () => {
    const modules = [{ file: '010-a.mjs', rows: [{ name: 'dup' }, { name: 'dup' }] }];

    expect(() => mergeScreens(modules)).toThrow(/dup/);
    expect(() => mergeScreens(modules)).toThrow(/010-a\.mjs/);
  });

  it('throws on a row with no name', () => {
    const modules = [{ file: '010-a.mjs', rows: [{ viewport: {} }] }];

    expect(() => mergeScreens(modules)).toThrow(/010-a\.mjs/);
  });
});

describe('mergeChannels', () => {
  it('copies a channel only one file defines, as-is', () => {
    const modules = [
      { file: '10-shell.mjs', channels: { 'app:getInfo': { version: '0.0.0' } } },
      { file: '20-issues.mjs', channels: {} },
    ];

    expect(mergeChannels(modules)).toEqual({ 'app:getInfo': { version: '0.0.0' } });
  });

  it('joins array channels defined in several files, in file order', () => {
    const modules = [
      { file: '10-shell.mjs', channels: { 'board:tasks': ['a', 'b'] } },
      { file: '40-archived.mjs', channels: { 'board:tasks': ['c'] } },
      { file: '50-sidebar.mjs', channels: { 'board:tasks': ['d'] } },
    ];

    expect(mergeChannels(modules)).toEqual({ 'board:tasks': ['a', 'b', 'c', 'd'] });
  });

  it('throws when a channel in two files is not an array in both, naming the channel and both files', () => {
    const modules = [
      { file: '10-shell.mjs', channels: { 'update:get': { status: 'idle' } } },
      { file: '20-issues.mjs', channels: { 'update:get': { status: 'auto' } } },
    ];

    expect(() => mergeChannels(modules)).toThrow(/update:get/);
    expect(() => mergeChannels(modules)).toThrow(/10-shell\.mjs/);
    expect(() => mergeChannels(modules)).toThrow(/20-issues\.mjs/);
  });
});

describe('loadScreens', () => {
  it('contains the 24 names from before the split, in their original relative order', async () => {
    const BEFORE_SPLIT = [
      'board-light',
      'board-dark',
      'sidebar-tree-light',
      'sidebar-tree-dark',
      'board-sidebar-open-detail-open',
      'board-sidebar-open-detail-closed-1100x800',
      'board-sidebar-open-detail-open-1100x800',
      'issue-list-light',
      'issue-list-dark',
      'issue-peek',
      'issue-full-screen',
      'visual-signoff-dark',
      'inbox-item-attachments',
      'files-section-grouped',
      'settings',
      'settings-updates-token',
      'palette',
      'archived-light',
      'ticket-archived-banner',
      'web-desktop',
      'web-archived',
      'web-issue-peek',
      'web-phone-light',
      'web-phone-dark',
    ];

    const names = (await loadScreens()).map((r) => r.name);

    let searchFrom = 0;
    for (const name of BEFORE_SPLIT) {
      const idx = names.indexOf(name, searchFrom);
      expect(idx, `expected "${name}" at or after index ${searchFrom}`).toBeGreaterThanOrEqual(0);
      searchFrom = idx + 1;
    }
  });
});

describe('loadFixtureChannels', () => {
  it('loads without throwing', async () => {
    await expect(loadFixtureChannels()).resolves.toBeTypeOf('object');
  });
});
