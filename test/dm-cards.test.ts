import { describe, expect, it } from 'vitest';
import { buildNewProjectFormCard, buildProjectListCard, buildProjectSettingsCard } from '../src/card/dm-cards';
import type { Project } from '../src/project/registry';

function project(i: number): Project {
  return {
    name: `项目 ${i}`,
    chatId: `oc_${i}`,
    cwd: `/tmp/project-${i}`,
    blank: false,
    createdAt: i,
    kind: 'multi',
    origin: 'created',
  };
}

describe('DM project list card', () => {
  it('caps visible projects to avoid Feishu CardKit element limits', () => {
    const card = buildProjectListCard(
      Array.from({ length: 25 }, (_, i) => project(i + 1)),
      new Map(),
    );
    const json = JSON.stringify(card);

    expect(json).toContain('项目 1');
    expect(json).toContain('项目 20');
    expect(json).not.toContain('项目 21');
    expect(json).toContain('共 25 个项目');
    expect(json).toContain('本卡显示前 20 个');
  });
});

describe('DM project settings card', () => {
  it('does not show the food MCP project toggle in normal settings', () => {
    const card = buildProjectSettingsCard(project(1));
    const json = JSON.stringify(card);

    expect(json).not.toContain('餐饮 MCP');
    expect(json).not.toContain('瑞幸');
    expect(json).not.toContain('麦当劳');
    expect(json).not.toContain('LUCKIN_MCP_TOKEN');
    expect(json).not.toContain('MCD_MCP_TOKEN');
  });
});

describe('DM new project card', () => {
  it('prefers GPT-5.5, medium reasoning, and standard speed as the initial project defaults', () => {
    const card = buildNewProjectFormCard({
      modelOptions: [
        { label: 'GPT-6', value: 'gpt-6' },
        { label: 'GPT-5.5', value: 'gpt-5.5' },
      ],
    });
    const json = JSON.stringify(card);

    expect(json).toContain('"name":"default_model"');
    expect(json).toContain('"initial_option":"gpt-5.5"');
    expect(json).toContain('"name":"default_effort"');
    expect(json).toContain('"initial_option":"medium"');
    expect(json).toContain('"name":"default_service_tier"');
    expect(json).toContain('"initial_option":"standard"');
    expect(json.indexOf('"name":"cloud_doc_folder"')).toBeLessThan(json.indexOf('"name":"default_model"'));
    expect(json.indexOf('默认模型选择')).toBeGreaterThan(json.indexOf('"name":"cloud_doc_folder"'));
    expect(json.indexOf('默认模型选择')).toBeLessThan(json.indexOf('"name":"default_model"'));
  });
});
