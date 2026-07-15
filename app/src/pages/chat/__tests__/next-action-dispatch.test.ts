import { describe, expect, it } from "vitest";
import { shouldRouteNextActionAsChatMessage } from "../next-action-dispatch";

// Task #9 独立复检发现的 HIGH 问题回归测试：debate 阶段有独立的 runDebateRuntime 执行入口，
// 只认"当前消息文本"里的博弈关键词，跟 workflowSnapshot.currentNodeId 完全解耦。
// 点击"开启多模型博弈"按钮如果走跟其余四个 next action 一样的确定性推进（只改
// currentNodeId），不会真的启动博弈——必须路由成一条真实聊天消息，走跟手打字完全一样的
// handleSend 管线。这个函数就是那个路由判断，独立测试防止以后有人"顺手"把 debate 也归并
// 进确定性推进的默认分支。
describe("shouldRouteNextActionAsChatMessage", () => {
  it("targetPhase 是 debate 时要走聊天消息管线，不能确定性推进", () => {
    expect(shouldRouteNextActionAsChatMessage({ targetPhase: "debate" })).toBe(true);
  });

  it.each(["plan", "review", "execute", "verify", "read_project"] as const)(
    "targetPhase 是 %s 时走确定性推进，不需要经过聊天消息管线",
    (targetPhase) => {
      expect(shouldRouteNextActionAsChatMessage({ targetPhase })).toBe(false);
    },
  );
});
