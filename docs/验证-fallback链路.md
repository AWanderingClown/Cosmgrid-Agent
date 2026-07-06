# 验证 fallback 链路（坑.md 1.1 + 1.2 真实验证入口）

> **本文档目标读者：真人用户**。AI 已经做了所有它能做的（补 mock 测试 + provider 规则表 + 报错识别）。剩下"用真实 API Key 触发 429 看 UI 行为"这部分必须真人做（烧钱 + 看屏幕）。

## 1. 为什么要验证？

`streamWithFallback` 的 429/rate_limit 识别、跨厂商回退链构造、上下文原样传递，架构和单元测试都到位了，但**没人在真实环境里端到端跑过一次**。

AI 已经做了的：
- ✅ 补 mock 集成测试（chat-fallback-integration.test.ts）覆盖 partial+429 等场景
- ✅ 新增 provider 专属规则表（provider-error-rules.ts），覆盖 MiniMax/DeepSeek/GLM/Kimi 的中文错误体
- ✅ error-classifier 接受 providerType 第三参数

AI 做不了的：
- ❌ 用真 key 触发 429（必须烧额度）
- ❌ 看 UI 的 switchNotice 是否正确出现（必须眼睛看）
- ❌ 看切换后的模型是否真的看到前面对话历史（必须眼脑结合）

## 2. 怎么验证（推荐步骤）

### 2.1 用最便宜的国产模型跑

> 国产 model 比 Anthropic 便宜，且触发 429 后回退链路更真实。

1. 打开 Cosmgrid-Agent
2. 进 API 接入页 → 添加 provider
3. 选一个**最便宜的**模型（比如智谱 GLM-4-Flash、DeepSeek V3、Kimi 等）
4. 添加 fallback 链：主模型 = X / fallback = Y（也可以用 Claude 作为 fallback）
5. 保存

### 2.2 触发 429（不需要真耗尽配额）

方法 A：故意用错 key 触发 401（验证鉴权失败切 fallback）

```
在对话页发一条消息 → 主模型 401 → 应该看到 UI 显示 "切换到 fallback 模型"
```

方法 B：高频发请求触发限流

```
连续发 20+ 条消息（每次都很短）→ 主模型被限流 → 触发 429 → 切 fallback
```

方法 C：用 probe 脚本探测（不用烧额度）

```bash
cd /Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/app

# 设环境变量
export PROBE_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export PROBE_API_KEY="你的 glm key"
export PROBE_MODEL_NAME="glm-4-flash"
export PROBE_PROVIDER_TYPE="glm"

# 跑探测
pnpm tsx scripts/probe-rate-limit-errors.ts

# 输出会显示：
# - 错 key 触发 401 的完整响应体
# - 超大 prompt 触发 413 的完整响应体
# - 不存在模型触发 404 的完整响应体
# 把 body 输出贴给 AI，AI 据此更新 provider-error-rules.ts
```

### 2.3 观察 UI 行为

触发 429 后看：
- [ ] UI 是否显示 "切换到 fallback 模型" 提示（switchNotice）
- [ ] 切换后的模型回复是否包含之前对话历史（验证上下文原样传递）
- [ ] 主模型是否被标记为 cooldown（连续发消息短时间内不会再选这个模型）

### 2.4 真实"额度耗尽"测试（可选，最严格）

如果想验证 5 小时套餐额度耗尽后的真实切 fallback：
1. 等 5 小时套餐耗尽（或用尽 GLM 账户余额）
2. 发消息 → 应该看到 fallback 模型立刻接管
3. **这条路径烧真钱**，建议先用最便宜模型测

## 3. 探测结果怎么用？

跑完 probe 脚本后，把 body 输出贴给 AI，AI 会：

1. **更新 `provider-error-rules.ts` 的规则表**：
   - 中文关键词（如 "余额不足"、"鉴权失败"）
   - 自定义状态码（如 MiniMax 1305、智谱 1214）
   - body JSON 字段结构（如 `error.code`、`error.message`）

2. **不需要改 error-classifier.ts**（它已经按 provider 规则表查询）

3. **不需要改 chat-fallback.ts**（它已经传 providerType）

## 4. 验证完成后

确认 fallback 链路端到端工作后，坑.md 1.1 + 1.2 的"未验证"状态可以标注为 ✅ "已验证"。

如果发现：
- 切 fallback 后 UI 没显示 switchNotice → 报告给 AI（这是 UI bug，不是回退链 bug）
- 切 fallback 后上下文丢失 → 报告给 AI（这是 chat-fallback bug，要查 buildRecoveryMessages）
- 主模型 429 没被识别 → 报告给 AI（带 probe 脚本输出的 body，AI 据此更新规则表）

## 5. 相关代码位置

| 文件 | 干什么 |
|------|--------|
| `app/src/lib/llm/chat-fallback.ts` | 回退链主逻辑 |
| `app/src/lib/llm/error-classifier.ts` | 错误分类（接受 providerType 第三参数） |
| `app/src/lib/llm/provider-error-rules.ts` | provider 专属规则表 |
| `app/src/lib/llm/__tests__/chat-fallback.test.ts` | mock 集成测试（1043 tests 通过） |
| `app/src/lib/llm/__tests__/error-classifier.test.ts` | 分类规则测试（含 provider 专属场景） |
| `app/scripts/probe-rate-limit-errors.ts` | 探测真实错误体的脚本 |

---

> 最后更新：2026-07-02。AI 端已全部完成，真人验证部分见上文。