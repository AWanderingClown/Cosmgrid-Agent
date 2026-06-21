// v0.7 阶段4 — 工具注册表
//
// 注册 + 按名查找 + 列表。供 ChatPage/ProjectDetailPage 把工具挂到模型，以及
// 把工具集转成 LLM 能识别的 tool schema。

import type { AnyToolDefinition } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  /** 注册一个工具；同名重复注册抛错（避免静默覆盖） */
  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: 工具 "${tool.name}" 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: AnyToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 只读工具子集（无需用户确认的那批） */
  listReadOnly(): AnyToolDefinition[] {
    return this.list().filter((t) => t.readOnly);
  }

  get size(): number {
    return this.tools.size;
  }
}
