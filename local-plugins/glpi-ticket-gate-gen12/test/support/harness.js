import { registerGate } from '../../lib/register.js';
export function hooksHarness() {
  const hooks = []; const logs = []; let factory;
  registerGate({ pluginConfig: { skillPath: new URL('../../README.md', import.meta.url).pathname },
    logger: { info: s => logs.push(s), warn: s => logs.push(s), debug: s => logs.push(s) },
    on: (name, fn, options) => hooks.push({ name, fn, options }),
    registerTool: f => { factory = f; } });
  return { logs, factory, emit(name, event = {}, ctx = {}) {
    return hooks.filter(h => h.name === name && (!h.options?.matcher || h.options.matcher.includes(event.toolName))).map(h => h.fn(event, ctx));
  } };
}
export const input = { customer_name: 'fixture customer', entity_id: 12, occurred_at: '2026-10-08 10:00',
  symptom: 'fixture symptom', method: 'fixture method', result: 'fixture result', assignee_user_id: 7, target_status: 5, category_id: 8, title: 'fixture title' };
