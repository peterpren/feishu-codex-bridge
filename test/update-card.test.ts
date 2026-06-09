import { describe, expect, it } from 'vitest';
import { buildDmMenuCard, buildUpdateCard } from '../src/card/dm-cards';
import { installTarget, manualInstallCommand, updateSourceLabel } from '../src/service/update';

describe('update console card', () => {
  it('shows the version update entry in the DM menu', () => {
    const json = JSON.stringify(buildDmMenuCard());
    expect(json).toContain('版本更新');
    expect(json).toContain('dm.update');
  });

  it('uses the customized npm package for one-click updates', () => {
    expect(installTarget()).toBe('peterpren-feishu-codex-bridge');
    expect(updateSourceLabel()).toBe('npm peterpren-feishu-codex-bridge');
    expect(manualInstallCommand()).toBe('npm i -g peterpren-feishu-codex-bridge');
  });

  it('offers reinstall from npm even when the package version is unchanged', () => {
    const json = JSON.stringify(
      buildUpdateCard({
        phase: 'checked',
        current: '0.3.5',
        latest: '0.3.5',
        hasUpdate: false,
        dev: false,
        source: updateSourceLabel(),
        installCommand: manualInstallCommand(),
      }),
    );
    expect(json).toContain('重新安装最新代码');
    expect(json).toContain('peterpren-feishu-codex-bridge');
    expect(json).not.toContain('@modelzen/feishu-codex-bridge@latest');
  });

  it('blocks one-click install in source checkout mode', () => {
    const json = JSON.stringify(
      buildUpdateCard({
        phase: 'checked',
        current: '0.3.5',
        latest: '0.3.6',
        hasUpdate: true,
        dev: true,
        source: updateSourceLabel(),
        installCommand: manualInstallCommand(),
      }),
    );
    expect(json).toContain('源码开发模式');
    expect(json).toContain('git pull --ff-only');
    expect(json).not.toContain('立即更新');
  });
});
