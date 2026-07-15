import { describe, expect, it } from "vitest";
import { enqueueSnapshotWrite } from "../workflow-runs";

// Task #9 独立复检发现的 MEDIUM 问题回归测试：saveSnapshot 底层是不带版本号的
// `UPDATE ... WHERE id = $runId`，而 tauri-plugin-sql 是连接池（非单连接，见
// connection.ts 顶部的事务边界铁律注释）——两次并发写同一个 runId 时，写入完成的
// 先后顺序不保证跟"调用顺序"一致，先调用但落盘慢的那次可能把后调用但落盘快的那次覆盖掉。
// enqueueSnapshotWrite 按 runId 把写入排成队列：不管每次 write() 实际耗时多久，
// 真正执行的顺序必须跟调用顺序一致。
describe("enqueueSnapshotWrite", () => {
  it("同一个 runId 的写入按调用顺序串行执行，即使先调用的那次耗时更长", async () => {
    const executionOrder: string[] = [];

    const slowFirstWrite = enqueueSnapshotWrite("run-race", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      executionOrder.push("first");
    });
    // 不等 slowFirstWrite，立刻发起第二次——模拟"点了按钮的落库还没完成，用户已经发了下一条消息"。
    const fastSecondWrite = enqueueSnapshotWrite("run-race", async () => {
      executionOrder.push("second");
    });

    await Promise.all([slowFirstWrite, fastSecondWrite]);

    expect(executionOrder).toEqual(["first", "second"]);
  });

  it("不同 runId 之间互不阻塞，各自的 write 都会执行", async () => {
    const executionOrder: string[] = [];

    await Promise.all([
      enqueueSnapshotWrite("run-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push("a");
      }),
      enqueueSnapshotWrite("run-b", async () => {
        executionOrder.push("b");
      }),
    ]);

    expect(executionOrder.sort()).toEqual(["a", "b"]);
  });

  it("前一次写入失败不影响同一个 runId 后续写入继续执行", async () => {
    const executionOrder: string[] = [];

    const failing = enqueueSnapshotWrite("run-fail-then-ok", async () => {
      throw new Error("simulated write failure");
    });
    const following = enqueueSnapshotWrite("run-fail-then-ok", async () => {
      executionOrder.push("recovered");
    });

    // enqueueSnapshotWrite 对外承诺"不把错误往上抛，避免一次失败永久卡住队列"
    await expect(failing).resolves.toBeUndefined();
    await following;

    expect(executionOrder).toEqual(["recovered"]);
  });
});
