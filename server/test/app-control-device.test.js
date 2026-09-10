import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_COMMANDS, validateAppCommand } from '../lib/app-control-schema.js';
import { DEVICE_APP_COMMANDS } from '../lib/app-control-device-schema.js';
import { APP_TOOLS } from '../../mcp/lib/app-tools.js';

test('device UI actions share validated schemas with the actual app tool catalog', () => {
  for (const [action, schema] of Object.entries(DEVICE_APP_COMMANDS)) {
    assert.equal(APP_COMMANDS[action], schema);
    const tool = APP_TOOLS.find(tool => tool.name === `app_${action}`);
    assert.ok(tool, action);
    assert.ok(tool.inputSchema.required.includes('clientId'));
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('saved device preferences validate nested sync choices, paths, permissions and bounded collections', () => {
  const args = { root: '~/Projects', devicesOff: ['device'], options: { stashDirty: false, repos: [{ id: 'project', enabled: false, env: false }], envExclude: ['local'] } };
  assert.deepEqual(validateAppCommand('configure_sync', args), args);
  assert.throws(() => validateAppCommand('configure_sync', { root: '/' }), /Invalid/);
  assert.throws(() => validateAppCommand('configure_sync', { options: { execute: 'command' } }), /Unknown/);
  assert.throws(() => validateAppCommand('configure_sync', { options: { repos: [{ id: 'project', enabled: 'yes', env: true }] } }), /Invalid/);
  assert.throws(() => validateAppCommand('configure_sync', { devicesOff: Array(65).fill('device') }), /Invalid/);
  assert.throws(() => validateAppCommand('configure_remote_desktop', { serverId: 'device', password: 'disallowed' }), /Unknown/);
  assert.throws(() => validateAppCommand('configure_quick_chat', { agent: 'unknown' }), /Invalid/);
  assert.throws(() => validateAppCommand('install_update', {}), /version/);
  assert.deepEqual(validateAppCommand('install_update', { version: '0.2.30' }), { version: '0.2.30' });
});
