import test from 'node:test';
import assert from 'node:assert/strict';
import { isTicketIntent } from '../lib/detect.js';

test('DEV-01 真实录单正语料（仅断言，不输出正文）', () => {
  for (const text of ['新建工单 客户波星通 网络故障', '润星新增加工单 网络故障', '新增工单', '录入 IT 工单', '创建工单', '新建it工单']) {
    assert.equal(isTicketIntent(text), true);
  }
});
test('DEV-01 讨论、查询、否定与无动作名词不触发', () => {
  for (const text of ['工单怎么录', '查询工单', '为何不按工单规则', '强制工单插件是否工作', '怎么创建工单', '新增工单规则是什么', '不要创建工单', 'GLPI工单', '工单录入', '', null]) {
    assert.equal(isTicketIntent(text), false);
  }
});

test('Review P1 明确录单指令可附带按规则/流程执行的说明', () => {
  for (const text of [
    '新建工单，客户 A，按照工单规则录入',
    '新建工单客户A按照工单规则录入',
    '请按照工单规则新建工单，客户A',
    '新增工单，客户A，遵循工单录入流程',
    '录入 IT 工单，客户A，使用工单模板',
    '创建工单，客户A，按流程处理',
    '润星新增加工单，按工单规则录入',
    '查询工单后，请新建工单，客户A',
    '不要查询工单，请新建工单，客户A',
    '新建工单，客户A，故障现象是查询功能无法工作',
    '新建工单，客户A，插件无法工作，按工单规则录入',
    '新建工单\n客户A\n按照工单规则录入',
  ]) assert.equal(isTicketIntent(text), true);
});

test('Review P1 查询、规则质询及命令引用不是录单指令', () => {
  for (const text of [
    '工单怎么录', '查询工单', '为何不按工单规则', '强制工单插件是否工作',
    '新建工单规则是什么', '新增工单的流程是什么', '创建工单步骤',
    '怎么新建工单，客户A，按照工单规则录入',
    '请解释新建工单，按照工单规则录入',
    '查询新增工单记录，客户A', '新增工单插件是否工作',
    '新建工单怎么操作', '可以创建工单吗？', '新建工单？',
    '“新建工单”，是什么意思', '他说新建工单，是否符合规则',
    '介绍录入 IT 工单的步骤', 'GLPI工单规则',
    '新建工单，流程是什么？', '新增工单，工单规则是什么',
    '创建工单，怎么操作', '新建工单，什么意思',
  ]) assert.equal(isTicketIntent(text), false);
});

test('Review P1 否定作用于其录单动作，附加规则说明不能消除否定', () => {
  for (const text of [
    '不要新建工单，客户A，按照工单规则录入',
    '请别创建工单，客户A', '暂不录入 IT 工单，按工单规则处理',
    '不新增工单，客户A', '取消新建工单，按流程处理',
    '不要按工单规则新建工单', '别帮我创建工单',
  ]) assert.equal(isTicketIntent(text), false);
});

test('Review P1 分句前的否定/提问与独立取消不能变成裸录单动作', () => {
  for (const text of [
    '不要，新建工单', '如何，创建工单', '工单怎么录，新增工单',
    '查询工单，新建工单', '新建工单，取消', '新建工单，算了',
  ]) assert.equal(isTicketIntent(text), false);
});
