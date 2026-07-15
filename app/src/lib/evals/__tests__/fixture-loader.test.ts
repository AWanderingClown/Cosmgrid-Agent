// Eval fixture 加载验证测试 —— 确保所有 fixture JSON 能被 loadEvalCase 正确加载 + schema 校验通过。
//
// 这个测试不跑真实模型，只验证：
// 1. listFixtureFiles 能扫到所有 .json 文件（不含 .gitkeep / manifest.json）
// 2. 每个 fixture 都能被 loadEvalCase 成功加载（schema 校验通过）
// 3. fixture 数量达到有意义规模（held-in ≥ 15, held-out ≥ 10）
// 4. 每个 fixture 的 acceptanceCriteria 引用的 grader 在注册表里存在
// 5. fixture id 唯一

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadEvalCase, listFixtureFiles } from "../fixture-loader";
import { listGraders } from "../graders";

const FIXTURES_DIR = "src/lib/evals/fixtures";

describe("eval fixture 加载验证", () => {
  const graderNames = new Set(listGraders());

  it("held-in fixture 数量 ≥ 15", () => {
    const files = listFixtureFiles(join(FIXTURES_DIR, "held-in"));
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it("held-out fixture 数量 ≥ 10", () => {
    const files = listFixtureFiles(join(FIXTURES_DIR, "held-out"));
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("所有 held-in fixture 都能被 loadEvalCase 加载", () => {
    const files = listFixtureFiles(join(FIXTURES_DIR, "held-in"));
    for (const file of files) {
      const filePath = join(FIXTURES_DIR, "held-in", file);
      // 不抛错 = 通过
      const evalCase = loadEvalCase(filePath);
      expect(evalCase.id).toBeTruthy();
      expect(evalCase.taskSetId).toBe("held-in");
      expect(evalCase.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("所有 held-out fixture 都能被 loadEvalCase 加载", () => {
    const files = listFixtureFiles(join(FIXTURES_DIR, "held-out"));
    for (const file of files) {
      const filePath = join(FIXTURES_DIR, "held-out", file);
      const evalCase = loadEvalCase(filePath);
      expect(evalCase.id).toBeTruthy();
      expect(evalCase.taskSetId).toBe("held-out");
      expect(evalCase.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("所有 fixture 的 grader 名称都在注册表里存在", () => {
    const allFiles = [
      ...listFixtureFiles(join(FIXTURES_DIR, "held-in")).map((f) => join(FIXTURES_DIR, "held-in", f)),
      ...listFixtureFiles(join(FIXTURES_DIR, "held-out")).map((f) => join(FIXTURES_DIR, "held-out", f)),
    ];
    for (const filePath of allFiles) {
      const evalCase = loadEvalCase(filePath);
      for (const criterion of evalCase.acceptanceCriteria) {
        expect(graderNames.has(criterion.grader)).toBe(true);
      }
    }
  });

  it("所有 fixture id 唯一", () => {
    const allFiles = [
      ...listFixtureFiles(join(FIXTURES_DIR, "held-in")).map((f) => join(FIXTURES_DIR, "held-in", f)),
      ...listFixtureFiles(join(FIXTURES_DIR, "held-out")).map((f) => join(FIXTURES_DIR, "held-out", f)),
    ];
    const ids = allFiles.map((fp) => loadEvalCase(fp).id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("fixture 覆盖 read_project / plan / execute / verify 四个阶段", () => {
    const allFiles = [
      ...listFixtureFiles(join(FIXTURES_DIR, "held-in")).map((f) => join(FIXTURES_DIR, "held-in", f)),
      ...listFixtureFiles(join(FIXTURES_DIR, "held-out")).map((f) => join(FIXTURES_DIR, "held-out", f)),
    ];
    const allTags = new Set<string>();
    for (const filePath of allFiles) {
      const evalCase = loadEvalCase(filePath);
      for (const tag of evalCase.tags ?? []) {
        allTags.add(tag);
      }
    }
    expect(allTags.has("read_project")).toBe(true);
    expect(allTags.has("plan")).toBe(true);
    expect(allTags.has("execute")).toBe(true);
    expect(allTags.has("verify")).toBe(true);
  });

  it("fixture 覆盖 4 种权限配置", () => {
    const allFiles = [
      ...listFixtureFiles(join(FIXTURES_DIR, "held-in")).map((f) => join(FIXTURES_DIR, "held-in", f)),
      ...listFixtureFiles(join(FIXTURES_DIR, "held-out")).map((f) => join(FIXTURES_DIR, "held-out", f)),
    ];
    const profiles = new Set<string>();
    for (const filePath of allFiles) {
      const evalCase = loadEvalCase(filePath);
      profiles.add(evalCase.permissionProfile);
    }
    expect(profiles.has("default")).toBe(true);
    expect(profiles.has("read-only")).toBe(true);
    expect(profiles.has("no-write")).toBe(true);
    expect(profiles.has("full-trust")).toBe(true);
  });
});
