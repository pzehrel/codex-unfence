import { createInterface } from 'node:readline';
import type { createManagedPatches, Inspection, Candidate } from './managed-patches.js';
import type { OperationResult } from './result.js';
import { publicActionName, renderDiagnostic, renderHuman, renderInspection } from './result.js';
import { assumptionDescription, evidenceDescription } from './cli-text.js';

type Managed = ReturnType<typeof createManagedPatches>;
export async function guide(managed: Managed, selection: { appPath?: string }, action?: string): Promise<OperationResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('修改文件需要交互终端。');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function ask(prompt: string, exact = false) {
    process.stdout.write(prompt);
    const line = await lines.next();
    return line.done ? null : exact ? line.value : line.value.trim();
  }
  let recoveredOperation = false;
  function cancelled() {
    process.stdout.write(recoveredOperation ? '恢复已完成，后续操作已取消。请核对报告的文件状态，完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用。\n' : '已取消，应用文件未修改。\n');
  }
  try {
    const discovery = await managed.discover(selection);
    if (discovery.diagnostics.length) process.stdout.write(`\n诊断：\n${discovery.diagnostics.flatMap(renderDiagnostic).join('\n')}\n`);
    if (!discovery.candidates.length) {
      if (action !== 'install' && action !== 'uninstall') throw new Error('未找到支持的 Codex 应用，请使用 --app 指定应用绝对路径。');
      const conflict = discovery.diagnostics.some(entry => ['PATH_ALIAS', 'IDENTITY_CHANGED', 'TARGET_CHANGED', 'UNTRUSTED_STORE'].includes(entry.code));
      const result: OperationResult = { schemaVersion: 1, command: action, outcome: conflict ? 'conflict' : 'runtime-error', exitCode: conflict ? 4 : 1, data: null, diagnostics: [...discovery.diagnostics, { code: 'NO_INSTALLATIONS', severity: 'error', message: 'No CUA installation found; provide --app with its absolute path.' }] };
      process.stdout.write(renderHuman(result));
      return result;
    }
    let candidate: Candidate | undefined = discovery.candidates[0];
    if (discovery.candidates.length > 1) {
      process.stdout.write('\n发现的应用：\n');
      discovery.candidates.forEach((entry, index) => process.stdout.write(`  ${index + 1}. ${entry.appPath}\n`));
      const choice = await ask('请输入应用编号，或输入 cancel 取消：');
      if (choice === null || choice === 'cancel') { cancelled(); return null; }
      candidate = /^\d+$/.test(choice) ? discovery.candidates[Number(choice) - 1] : undefined;
      if (!candidate) throw new Error('请输入列表中的应用编号。');
    }
    if (!candidate) throw new Error('尚未选择应用。');
    let inspection: Inspection = await managed.inspect(candidate);
    while (true) {
      process.stdout.write(`\n${renderInspection(inspection).join('\n')}\n\n`);
      const diagnostics = [...inspection.diagnostics, ...inspection.blockers];
      if (diagnostics.length) process.stdout.write(`诊断：\n${diagnostics.flatMap(renderDiagnostic).join('\n')}\n\n`);
      if (inspection.recovery) process.stdout.write(`恢复工具：${inspection.recovery.tool.packageName}@${inspection.recovery.tool.version}\n命令：${inspection.recovery.tool.executable}\n请保留对应版本的工具及全部恢复数据。\n`);
      const requested = action ?? await ask(`选择操作（${[...inspection.allowedActions.map(publicActionName), 'recheck', 'cancel'].join(', ')}）：`);
      if (requested === null || requested === 'cancel') { cancelled(); return null; }
      if (requested === 'recheck') { inspection = await managed.inspect(candidate); continue; }
      const command = requested === 'install' ? 'apply' : requested === 'uninstall' ? 'restore' : requested;
      if (command !== 'apply' && command !== 'restore' && command !== 'recover') throw new Error('请选择列表中的操作。');
      if ((requested === 'install' || requested === 'uninstall') && inspection.state === 'incomplete' && inspection.allowedActions.includes('recover')) {
        process.stdout.write('需要先回滚中断的操作。恢复会返回操作前的状态，不会继续完成该操作。\n应用及相关服务正在运行时仍可写入；写入成功后，必须完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用。\n');
        const confirmed = await ask('输入 yes 确认恢复，其他输入取消：', true);
        if (confirmed !== 'yes') { cancelled(); return null; }
        if (!inspection.inspectionToken) throw new Error('检查结果未通过验证，请重新检查。');
        const recovered = await managed.recover({ candidate: inspection.candidate, inspectionToken: inspection.inspectionToken, confirmed: true });
        process.stdout.write(renderHuman(recovered));
        if (recovered.exitCode !== 0) {
          process.stdout.write('恢复未完成。请保留恢复数据，并运行 check；核对结果后再重新打开应用。\n');
          return recovered;
        }
        recoveredOperation = true;
        inspection = await managed.inspect(candidate);
        continue;
      }
      if (requested === 'uninstall' && inspection.state === 'original' && !inspection.recovery && inspection.support === 'supported' && inspection.writeReadiness === 'ready') {
        process.stdout.write('uninstall：成功\n补丁已卸载，原始文件未修改。\n运行效果：未验证。\n');
        return null;
      }
      if (!inspection.allowedActions.includes(command)) {
        process.stdout.write(`当前无法执行 ${publicActionName(command)}，请处理诊断中的问题后重新检查。\n`);
        if (!action) continue;
        const choice = await ask('选择操作（recheck, cancel）：');
        if (choice !== 'recheck') {
          const outcome = inspection.writeReadiness === 'unknown' || inspection.operation?.outcome === 'runtime-error' ? 'runtime-error'
            : inspection.state === 'conflict' || inspection.blockers.length ? 'conflict' : 'incompatible';
          const result: OperationResult = { schemaVersion: 1, command: requested === 'install' || requested === 'uninstall' ? requested : command, outcome, exitCode: outcome === 'runtime-error' ? 1 : outcome === 'conflict' ? 4 : 3, data: null, diagnostics: [...inspection.diagnostics, ...inspection.blockers] };
          process.stdout.write(renderHuman(result));
          return result;
        }
        inspection = await managed.inspect(candidate);
        continue;
      }
      process.stdout.write('\n兼容性详情：\n');
      for (const evidence of inspection.derivation?.evidence ?? []) process.stdout.write(`  依据：${evidenceDescription(evidence)}\n`);
      for (const assumption of inspection.derivation?.assumptions ?? []) process.stdout.write(`  前提：${assumptionDescription(assumption)}\n`);
      process.stdout.write(`\n确认前请核对：\n目标文件：${inspection.candidate.targetPath}\n作用范围：仅修改站点状态响应，保留原始请求和判定逻辑。\n备份和恢复数据私密保存在 npm 缓存之外。\n修改应用资源会使签名校验失败，本工具不会重新签名。\n应用及相关服务正在运行时仍可写入；写入成功后，必须完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用。\n${command === 'recover' ? '恢复会回滚到中断操作之前的状态，不会继续安装或卸载。\n' : ''}`);
      const confirmed = await ask(`输入 yes 确认 ${publicActionName(command)}，其他输入取消：`, true);
      if (confirmed !== 'yes') { cancelled(); return null; }
      if (!inspection.inspectionToken) throw new Error('检查结果未通过验证，请重新检查。');
      const result = await managed[command]({ candidate: inspection.candidate, inspectionToken: inspection.inspectionToken, confirmed: true });
      process.stdout.write(renderHuman({ ...result, command: requested === 'install' || requested === 'uninstall' ? requested : result.command }));
      if (result.exitCode === 0) {
        process.stdout.write('运行效果：未验证。核对文件状态后，请完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用。\n');
        if (result.data?.targets.some(target => target.state === 'tool-applied')) process.stdout.write('补丁会保留至卸载。\n');
      } else process.stdout.write('操作未成功完成。请保留恢复数据，运行 check 后再重新打开应用；操作中断时，可重新运行 install 或 uninstall 按提示恢复。\n');
      process.stdout.write('请保留对应版本的工具和恢复数据；清理 npm 缓存不会删除恢复数据。\n');
      return result;
    }
  } finally { input.close(); }
}
