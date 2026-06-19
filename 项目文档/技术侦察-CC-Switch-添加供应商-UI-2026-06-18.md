# 技术侦察：CC Switch "添加供应商 UI" 抄录报告

> **侦察对象**: `/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/`
> **侦察目标**: Cosmgrid-Agent v0.2 API 接入页（任务 7.3）+ workRoles 多选字段
> **报告日期**: 2026-06-18
> **侦察者**: Claude（技术侦察兵）

---

## 一、TL;DR（先看这段）

CC Switch 的 "添加供应商" 实际有 **3 套 UI**，按"应用维度"分层：

| UI 入口 | 路径 | 何时用 |
|---|---|---|
| **AddProviderDialog** | `src/components/providers/AddProviderDialog.tsx` | 顶层"添加供应商"弹窗容器（包 Tabs） |
| **ProviderForm** | `src/components/providers/forms/ProviderForm.tsx` | 实际表单（按 appId 路由到 6 个子表单） |
| **UniversalProviderFormModal** | `src/components/universal/UniversalProviderFormModal.tsx` | "统一供应商" Tab 内的"一次配 Claude/Codex/Gemini 三端"的合并表单（**v0.2 最值得抄**） |

**核心结论**：

1. **CC Switch 的"添加供应商"重点不在 Provider 维度，而在"对接哪个 CLI 工具"**（Claude/Codex/Gemini/OpenCode/Hermes/ClaudeDesktop）。它每次添加一个供应商，就是给一个 CLI 工具新增一个 endpoint。
2. **Cosmgrid-Agent 要抄的不是"按 appId 路由"那套，而是 UniversalProviderFormModal 的"统一表单"模式**——v0.2 的"添加 API" = "我有一个 Provider + 一个 ApiCredential + 多个 Model"。
3. **CC Switch 的 API Key 不加密**：明文存进 SQLite 的 `settings_config` JSON 字段。Cosmgrid-Agent 的 `apiKeyEncrypted` 字段名已经在 schema 里了。
   - **v0.2 临时方案**（已落地）：前端 Web Crypto AES-GCM + 固定密钥派生，存密文到 DB
   - **v0.3 TODO**：接 tauri-plugin-keyring（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）
4. **CC Switch 的"测试连接"不在添加对话框内**，只在 ProviderList 列表项上对**已保存**的供应商做流式健康检查（`stream_check_provider`）。v0.2 要在 Form 内加"测试连接"按钮（用户痛点）→ v0.2 后端 `POST /api/chat/test-connection` 已实现。
5. **workRoles 是 Cosmgrid-Agent 独有字段**（CC Switch 没有这概念），要新加。在 Model 表层做多选下拉，**8 个枚举值**：`main_chat / planning / review / frontend / backend / testing / final_review / general`（注意 `review` 和 `final_review` 都存在，`general` 是兜底角色）。

---

## 二、CC Switch 添加供应商组件位置（实际文件 + 行号）

### 2.1 入口容器：AddProviderDialog

**文件**：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/src/components/providers/AddProviderDialog.tsx`
**总行数**：377 行
**核心结构**（行 25-43，Props 定义）：

```tsx
// 来源: AddProviderDialog.tsx:25-43
interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  onSubmit: (
    provider: Omit<Provider, "id"> & {
      providerKey?: string;
      suggestedDefaults?: OpenClawSuggestedDefaults;
      ensureClaudeDesktopOfficialSeed?: boolean;
    },
  ) => Promise<void> | void;
}
```

**关键决策逻辑**（行 46-50）：

```tsx
// 来源: AddProviderDialog.tsx:46-50
// OpenCode and OpenClaw don't support universal providers
const showUniversalTab =
  appId !== "opencode" &&
  appId !== "openclaw" &&
  appId !== "hermes" &&
  appId !== "claude-desktop";
```

**Tauri 后端调用**（行 59-84）：`handleUniversalProviderSave` 通过 `universalProvidersApi.upsert(provider)` 把数据交给 Rust 后端。

### 2.2 实际表单：ProviderForm（按 appId 路由）

**文件**：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/src/components/providers/forms/ProviderForm.tsx`
**总行数**：83KB（超级大文件）
**入口路由**（行 236-242）：

```tsx
// 来源: ProviderForm.tsx:236-242
export function ProviderForm(props: ProviderFormProps) {
  if (props.appId === "claude-desktop") {
    return <ClaudeDesktopProviderForm {...props} />;
  }
  return <ProviderFormFull {...props} />;
}
```

**基础字段组件**：`BasicFormFields.tsx`（5.8KB，行 125-156）—— 包含 name / notes / websiteUrl 三个 Input：

```tsx
// 来源: BasicFormFields.tsx:125-156（基础字段网格布局）
<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
  <FormField control={form.control} name="name" render={({ field }) => (
    <FormItem>
      <FormLabel>{t("provider.name")}</FormLabel>
      <FormControl>
        <Input {...field} placeholder={t("provider.namePlaceholder")} />
      </FormControl>
      <FormMessage />
    </FormItem>
  )} />
  <FormField control={form.control} name="notes" render={({ field }) => (
    <FormItem>...<Input {...field} placeholder={...} /></FormItem>
  )} />
</div>
<FormField control={form.control} name="websiteUrl" render={({ field }) => (
  <FormItem>
    <FormLabel>{t("provider.websiteUrl")}</FormLabel>
    <FormControl>
      <Input {...field} placeholder={t("providerForm.websiteUrlPlaceholder")} />
    </FormControl>
  </FormItem>
)} />
```

### 2.3 Zod Schema（zod 校验）

**文件**：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/src/lib/schemas/provider.ts`
**总行数**：61 行
**完整 schema**（行 38-58）：

```ts
// 来源: provider.ts:38-58
export const providerSchema = z.object({
  name: z.string(), // 必填校验移至 handleSubmit 中用 toast 提示
  websiteUrl: z.string().url("请输入有效的网址").optional().or(z.literal("")),
  notes: z.string().optional(),
  settingsConfig: z
    .string()
    .min(1, "请填写配置内容")
    .superRefine((value, ctx) => {
      try {
        JSON.parse(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: parseJsonError(error),
        });
      }
    }),
  // 图标配置
  icon: z.string().optional(),
  iconColor: z.string().optional(),
});

export type ProviderFormData = z.infer<typeof providerSchema>;
```

**要点**：
- `name` 不在 schema 校验，移到 `handleSubmit` 用 toast 提示（避免 schema 报错遮挡其他字段）。
- `settingsConfig` 是 JSON 字符串，用 `superRefine` + try/catch 解析，把"位置 123 的非法 token"这种错误友好化（行 6-36 的 `parseJsonError`）。
- `icon` 和 `iconColor` 可选。

### 2.4 API Key 输入控件：ApiKeyInput

**文件**：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/src/components/providers/forms/ApiKeyInput.tsx`
**总行数**：70 行
**核心结构**（行 37-66）：

```tsx
// 来源: ApiKeyInput.tsx:37-66
return (
  <div className="space-y-2">
    <label htmlFor={id} className="block text-sm font-medium text-foreground">
      {label} {required && "*"}
    </label>
    <div className="relative">
      <input
        type={showKey ? "text" : "password"}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("apiKeyInput.placeholder")}
        disabled={disabled}
        required={required}
        autoComplete="off"
        className={inputClass}
      />
      {!disabled && value && (
        <button
          type="button"
          onClick={toggleShowKey}
          className="absolute inset-y-0 right-0 flex items-center pr-3 ..."
          aria-label={showKey ? t("apiKeyInput.hide") : t("apiKeyInput.show")}
        >
          {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
    </div>
  </div>
);
```

**Props**（行 5-13）：

```tsx
interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  id?: string;
}
```

**要点**：
- **没用到 React Hook Form**——是受控组件（`onChange` 直接回调），不是 `<FormField>`。原因是各 appId 都有不同字段要塞进 JSON，不是统一 schema。
- `autoComplete="off"` 防止浏览器记住 API Key。
- 右侧眼睛按钮仅在 `!disabled && value` 时显示（空值时藏起来）。

### 2.5 "统一供应商" 模式：UniversalProviderFormModal

**文件**：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/src/components/universal/UniversalProviderFormModal.tsx`
**总行数**：720 行
**核心字段集**（行 41-48）：

```tsx
// 来源: UniversalProviderFormModal.tsx:41-48
const [selectedPreset, setSelectedPreset] = useState<UniversalProviderPreset | null>(null);
const [name, setName] = useState("");
const [baseUrl, setBaseUrl] = useState("");
const [apiKey, setApiKey] = useState("");
const [showApiKey, setShowApiKey] = useState(false);
const [websiteUrl, setWebsiteUrl] = useState("");
const [notes, setNotes] = useState("");
```

**应用启用 Switch**（行 51-53，**v0.2 抄这个**）：

```tsx
// 来源: UniversalProviderFormModal.tsx:51-53
const [claudeEnabled, setClaudeEnabled] = useState(true);
const [codexEnabled, setCodexEnabled] = useState(true);
const [geminiEnabled, setGeminiEnabled] = useState(true);
```

**App Switch UI 渲染**（行 484-515）：

```tsx
// 来源: UniversalProviderFormModal.tsx:484-515
<div className="flex flex-col gap-3">
  <div className="flex items-center justify-between rounded-lg border p-3">
    <div className="flex items-center gap-2">
      <ProviderIcon icon="claude" name="Claude" size={20} />
      <span className="font-medium">Claude Code</span>
    </div>
    <Switch checked={claudeEnabled} onCheckedChange={setClaudeEnabled} />
  </div>
  <div className="flex items-center justify-between rounded-lg border p-3">
    <div className="flex items-center gap-2">
      <ProviderIcon icon="openai" name="Codex" size={20} />
      <span className="font-medium">OpenAI Codex</span>
    </div>
    <Switch checked={codexEnabled} onCheckedChange={setCodexEnabled} />
  </div>
  <div className="flex items-center justify-between rounded-lg border p-3">
    <div className="flex items-center gap-2">
      <ProviderIcon icon="gemini" name="Gemini" size={20} />
      <span className="font-medium">Gemini CLI</span>
    </div>
    <Switch checked={geminiEnabled} onCheckedChange={setGeminiEnabled} />
  </div>
</div>
```

**模型配置块**（行 525-575，仅展示 Claude 部分）：

```tsx
// 来源: UniversalProviderFormModal.tsx:525-575
{/* Claude 模型 */}
{claudeEnabled && (
  <div className="space-y-3 rounded-lg border p-4">
    <div className="flex items-center gap-2 font-medium">
      <ProviderIcon icon="claude" name="Claude" size={16} />
      Claude
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">{t("universalProvider.model", { defaultValue: "主模型" })}</Label>
        <Input
          value={models.claude?.model || ""}
          onChange={(e) => updateModel("claude", "model", e.target.value)}
          placeholder="claude-sonnet-4-20250514"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Haiku</Label>
        <Input
          value={models.claude?.haikuModel || ""}
          onChange={(e) => updateModel("claude", "haikuModel", e.target.value)}
          placeholder="claude-haiku-4-20250514"
        />
      </div>
      // ... Sonnet / Opus 同款
    </div>
  </div>
)}
```

**updateModel 实现**（行 114-125）：

```tsx
// 来源: UniversalProviderFormModal.tsx:114-125
const updateModel = useCallback(
  (app: "claude" | "codex" | "gemini", field: string, value: string) => {
    setModels((prev) => ({
      ...prev,
      [app]: {
        ...(prev[app] || {}),
        [field]: value,
      },
    }));
  },
  [],
);
```

---

## 三、字段清单表格

### 3.1 UniversalProviderFormModal 实际字段（最值得抄的）

| 字段名 | 类型 | 必填 | UI 控件 | Cosmgrid-Agent 字段 | 要改？ |
|---|---|---|---|---|---|
| `name` | string | 是 | `<Input>` | `Provider.name` | **直接抄** |
| `baseUrl` | string | 是 | `<Input>` | `ApiCredential.baseUrl` | **直接抄** |
| `apiKey` | string | 是 | `<Input type="password">` + 眼睛按钮 | `ApiCredential.apiKeyEncrypted` | **抄结构，但要做加密** |
| `showApiKey` | boolean | 否 | 眼睛按钮 toggle | 同上 | **直接抄** |
| `websiteUrl` | string | 否 | `<Input>` | `Provider.website` | **直接抄** |
| `notes` | string | 否 | `<Input>` | `Provider.notes` | **直接抄** |
| `claudeEnabled` | boolean | 默认 true | `<Switch>` | **不抄**（Cosmgrid-Agent 不分 CLI 端） |
| `codexEnabled` | boolean | 默认 true | `<Switch>` | **不抄** | |
| `geminiEnabled` | boolean | 默认 true | `<Switch>` | **不抄** | |
| `models.claude.model` | string | 是（启用时） | `<Input>` | `Model.name` | **改成 workRoles 多选** |
| `models.claude.haikuModel` | string | 是（启用时） | `<Input>` | **删掉**（Cosmgrid-Agent 不分 haiku/sonnet/opus） | |
| `models.claude.sonnetModel` | string | 是（启用时） | `<Input>` | 同上 | |
| `models.claude.opusModel` | string | 是（启用时） | `<Input>` | 同上 | |
| `models.codex.model` | string | 是 | `<Input>` | **合并到 workRoles** | |
| `models.gemini.model` | string | 是 | `<Input>` | **合并到 workRoles** | |
| `workRoles`（新增） | `WorkRole[]` | 是 | **Multi-select 下拉** | `Model.workRoles` | **新增，见第 4 节** |
| `icon` | string | 否 | IconPicker | **v0.2 暂不做**（v0.3 再加） | |
| `iconColor` | string | 否 | ColorPicker | 同上 | |

### 3.2 ProviderForm（按 appId 路由）字段

| 字段名 | 类型 | 必填 | UI 控件 | Cosmgrid-Agent 要不要？ |
|---|---|---|---|---|
| `name` | string | 是 | `<Input>` | 要（Provider.name） |
| `notes` | string | 否 | `<Input>` | 要（Provider.notes） |
| `websiteUrl` | string | 否 | `<Input type=url>` | 要（Provider.website） |
| `settingsConfig` | string(JSON) | 是 | `<JsonEditor>` | **不抄**（Cosmgrid-Agent 不用 settingsConfig，用 ApiCredential + Model 拆分） |
| `presetId` | string | 否 | ProviderPresetSelector | **不抄**（v0.2 只支持 7 种主流 provider 预设） |
| `icon` / `iconColor` | string | 否 | IconPicker | **v0.2 暂不做** |
| `meta.custom_endpoints` | object | 否 | 自动从 settingsConfig 提取 | **不抄** |

### 3.3 ApiKeyInput 单独组件字段

| 字段名 | 类型 | 必填 | UI 控件 | 备注 |
|---|---|---|---|---|
| `value` | string | - | `<input type=password>` | 受控 |
| `onChange` | `(v: string) => void` | 是 | - | 必填 |
| `placeholder` | string | 否 | - | 默认 "sk-..." |
| `disabled` | boolean | 否 | - | |
| `required` | boolean | 否 | label 后加 `*` | |
| `label` | string | 否 | - | 默认 "API Key" |
| `id` | string | 否 | - | 默认 "apiKey" |

---

## 四、API Key 加密方式（CC Switch 实际做法）

### 4.1 实际结论：**CC Switch 不加密 API Key**

**证据 1：Rust 后端存储 SQL**（`src-tauri/src/database/dao/providers.rs:240-264`）：

```rust
// 来源: cc-switch-main/src-tauri/src/database/dao/providers.rs:240-264
"INSERT INTO providers (
    id, app_type, name, settings_config, website_url, category,
    created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
params![
    provider.id,
    app_type,
    provider.name,
    serde_json::to_string(&provider.settings_config)?,  // ← settings_config 整个 JSON 化，里面包含明文 apiKey
    ...
]
```

**证据 2：前端 apiKey 直接以字符串存 settingsConfig**（`UniversalProviderFormModal.tsx:128-184`）：

```tsx
// 来源: UniversalProviderFormModal.tsx:128-184
const claudeConfigJson = useMemo(() => {
  if (!claudeEnabled) return null;
  return {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,  // ← 明文 API Key
      ANTHROPIC_MODEL: model,
      ...
    },
  };
}, [claudeEnabled, baseUrl, apiKey, models.claude]);
```

**证据 3：Cargo.toml 无加密 crate**（`src-tauri/Cargo.toml:1-80`）—— 没有任何 `tauri-plugin-stronghold` / `aes-gcm` / `ring::aead` / `chacha20poly1305` 依赖。

### 4.2 依赖的安全模型

CC Switch 走的是 **Tauri 沙箱 + SQLite 文件权限** 路线：
- 应用数据目录在 `~/Library/Application Support/cc-switch/`（macOS）
- 数据库是普通 SQLite 文件，靠 OS 文件权限隔离
- 没读取时解密开销

### 4.3 Cosmgrid-Agent 的方案

`prisma/schema.prisma:41` 字段已命名 `apiKeyEncrypted`：

```prisma
// 来源: app/prisma/schema.prisma:41
apiKeyEncrypted      String // 加密存储（v0.2 实际接 API 时再实现加密层）
```

**v0.2 推荐方案**：

| 方案 | 优点 | 缺点 | v0.2 用？ |
|---|---|---|---|
| **A. 明文存 SQLite**（学 CC Switch） | 简单、零依赖、零性能开销 | 不安全，备份导出泄漏 | ❌ 不推荐 |
| **B. crypto.subtle AES-GCM + 固定密钥派生** | 跨平台、纯 JS | 密钥在代码里，可被逆向 | ⚠️ 临时方案 |
| **C. crypto.subtle AES-GCM + 系统 keychain** | 真正安全、用户级隔离 | 需要 OS 调用，dev 复杂 | ✅ **v0.2+ 推荐** |
| **D. Tauri stronghold plugin**（CC Switch 没用） | 官方推荐 | 引入新 crate、dev 复杂 | 留 v0.3 评估 |

**v0.2 最小可行方案（方案 C 简化版）**：

```typescript
// app/src/lib/crypto.ts（新文件）
// 用 Web Crypto API，密钥派生用 PBKDF2 from app-level passphrase
export async function encryptApiKey(plain: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  // base64(iv || ciphertext)
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(ciphertext)));
}
export async function decryptApiKey(b64: string, key: CryptoKey): Promise<string> {
  // 反向：base64 解码 → split iv/cipher → AES-GCM decrypt
}
```

**Key 派生**：首次启动时弹窗让用户设 6 位 PIN（可空，空则用设备指纹派生）。Key 不存磁盘，只在内存里。

**v0.2 简化决定**（如果时间紧）：**先用方案 B（固定密钥）**，注释里写 TODO："v0.3 切到方案 C"。字段已经叫 `apiKeyEncrypted`，落库前调 `encryptApiKey()` 就行。

---

## 五、关键交互

### 5.1 "测试连接" 按钮 —— **CC Switch 实际没有**

**证据**：`grep -rn "测试连接\|testConnection" src/components/providers/forms/` 在 AddProviderDialog / ProviderForm / EditProviderDialog 内都搜不到"测试连接"按钮。

CC Switch 的"健康检查"位置：
- `ProviderList.tsx:204` —— 列表行上对**已保存**供应商的"流式健康检查"
- `useStreamCheck.ts:89` —— 检查中的状态管理
- `model-test.ts:33` —— 调 `stream_check_provider` Tauri command

**Cosmgrid-Agent v0.2 必须做**：因为用户痛点是"填了 API Key 不知道对不对"，建议在 ApiCredential 字段下加"测试连接"按钮：

```tsx
// 设计（v0.2 新增，不抄 CC Switch）
<div className="space-y-2">
  <Label>API Key *</Label>
  <div className="flex gap-2">
    <div className="relative flex-1">
      <Input
        type={showApiKey ? "text" : "password"}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="sk-..."
        autoComplete="off"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setShowApiKey(!showApiKey)}
      >
        {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
      </Button>
    </div>
    <Button
      type="button"
      variant="outline"
      onClick={handleTestConnection}
      disabled={!apiKey || !baseUrl || isTesting}
    >
      {isTesting ? <Loader2 className="animate-spin" size={16} /> : <Zap size={16} />}
      测试连接
    </Button>
  </div>
  {testResult && (
    <Alert variant={testResult.success ? "default" : "destructive"}>
      {testResult.success ? "连接成功，延迟 Xms" : `连接失败：${testResult.error}`}
    </Alert>
  )}
</div>
```

**后端 `handleTestConnection` 逻辑**：
- 调新建的 Tauri command `test_provider_connection`（v0.2 新增）
- 内部用 Vercel AI SDK `generateText({ model, prompt: "ping" })`，10s 超时
- 返回 `{ success: boolean, latencyMs?: number, error?: string }`

### 5.2 启用/禁用 Switch 的位置

CC Switch 三个位置有 Switch：
1. **UniversalProviderFormModal.tsx:51-53**：claude/codex/gemini 三个 App 的启用
2. **BasicFormFields.tsx 没有**（只有 name/notes/websiteUrl）
3. **ProviderCard.tsx:24k**（列表项右侧有 Switch 控制"是否当前生效"）

**v0.2 Cosmgrid-Agent 对应位置**：
- **添加表单内**：模型行的"启用 Switch"（Model.enabled 字段，对应 `prisma/schema.prisma:98`）
- **列表项右侧**：ProviderCard 的 enabled Switch（`ApiCredential.enabled`，行 42）

### 5.3 表单校验逻辑

**CC Switch**：
- `react-hook-form` + `zodResolver(providerSchema)`（ProviderForm.tsx:3-10）
- 校验在 schema 里做基本类型 + JSON 格式 + URL 格式
- **name 必填校验移到 handleSubmit**（用 toast 提示，不用 schema）

**v0.2 Cosmgrid-Agent 对应**：
- 已有 `app/server/schemas.ts:22-33` 的 `createApiCredentialSchema`，直接拿来用
- 已有 `createModelSchema`（行 91-102），`workRoles` 字段已校验为非空 JSON 字符串数组
- 前端用 `react-hook-form` + `@hookform/resolvers/zod`

---

## 六、新增 workRoles 字段的设计方案

### 6.1 字段定义（来自 `prisma/schema.prisma:97`）

```prisma
// 来源: app/prisma/schema.prisma:97
workRoles      String // JSON 字符串数组：main_chat/planning/review/frontend/backend/testing/final_review/general（必填）
```

**8 个枚举值**（来自 `app/server/schemas.ts:118-126`）：

```ts
z.enum([
  "main_chat",     // 主对话（默认必须有）
  "planning",      // 计划阶段
  "review",        // 代码 review
  "frontend",      // 前端实现
  "backend",       // 后端实现
  "testing",       // 测试
  "final_review",  // 最终审核
  "general",       // 通用兜底
])
```

注意：枚举值里有 `review` 和 `final_review` **两个 review**（不是同一个），`general` 是兜底角色。

### 6.2 UI 设计：Multi-select 下拉框

**v0.2 用什么组件？** Cosmgrid-Agent 还没装 shadcn/ui。三个选择：

| 方案 | 优点 | 缺点 | 抄 CC Switch？ |
|---|---|---|---|
| **A. 8 个 Checkbox 列表**（学 Claude 字段布局） | 0 依赖、最快 | 占用空间大 | **直接抄** UniversalProviderFormModal 的多 Switch 模式 |
| **B. shadcn Popover + Checkbox** | 紧凑、专业 | 需要先 `npx shadcn-ui@latest init` | 不抄 |
| **C. 原生 `<select multiple>`** | 0 依赖 | UX 极差 | **不抄** |

**v0.2 推荐方案 A**（学 CC Switch 模式）：

```tsx
// 设计稿：v0.2 新增 src/components/providers/WorkRoleSelector.tsx
const WORK_ROLES: Array<{ value: WorkRole; label: string; description: string }> = [
  { value: "main_chat", label: "主对话", description: "用户跟 AI 的直接对话" },
  { value: "planning", label: "计划阶段", description: "任务分解、架构设计" },
  { value: "review", label: "代码 review", description: "PR/代码审查" },
  { value: "frontend", label: "前端实现", description: "UI/CSS/组件" },
  { value: "backend", label: "后端实现", description: "API/DB/服务" },
  { value: "testing", label: "测试", description: "单测/集成测试" },
  { value: "final_review", label: "最终审核", description: "完整方案复核" },
  { value: "general", label: "通用兜底", description: "无明确角色时" },
];

interface WorkRoleSelectorProps {
  value: WorkRole[];
  onChange: (roles: WorkRole[]) => void;
  required?: boolean;
}

export function WorkRoleSelector({ value, onChange, required }: WorkRoleSelectorProps) {
  const toggle = (role: WorkRole) => {
    const next = value.includes(role)
      ? value.filter(r => r !== role)
      : [...value, role];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <Label>工作角色 {required && <span className="text-destructive">*</span>}</Label>
      <div className="grid grid-cols-2 gap-2">
        {WORK_ROLES.map(({ value: role, label, description }) => (
          <label
            key={role}
            className="flex items-start gap-2 p-2 rounded border cursor-pointer hover:bg-accent"
          >
            <Checkbox
              checked={value.includes(role)}
              onCheckedChange={() => toggle(role)}
            />
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted-foreground">{description}</div>
            </div>
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <p className="text-xs text-destructive">至少选择 1 个工作角色</p>
      )}
    </div>
  );
}
```

### 6.3 默认值 & 必填性

- **必填**：`createModelSchema` 已校验 `arr.length > 0`（`schemas.ts:83`）
- **默认值**：建议 `["main_chat"]`（用户最常见用途）
- **UI 提示**：未选时下方红色提示"至少选择 1 个工作角色"

### 6.4 跟 Model 表的联动

```ts
// 提交时把数组序列化成 JSON 字符串存 Model.workRoles
onSubmit: (data) => {
  // 1. POST /api/providers 创建 Provider
  const provider = await api.post("/api/providers", {
    name: data.providerName,
    type: data.providerType,  // anthropic/openai/google/...
  });

  // 2. POST /api/api-credentials 创建 ApiCredential
  const credential = await api.post("/api/api-credentials", {
    providerId: provider.data.id,
    name: data.credentialName,
    baseUrl: data.baseUrl,
    apiKeyEncrypted: await encryptApiKey(data.apiKey, key),
    enabled: data.enabled,
    supportsStreaming: true,
    supportsFunctionCall: true,
    supportsVision: data.supportsVision ?? false,
  });

  // 3. POST /api/models 创建 Model
  await api.post("/api/models", {
    providerId: provider.data.id,
    name: data.modelName,         // 如 "claude-sonnet-4-20250514"
    displayName: data.displayName,  // 如 "Claude Sonnet 4"
    contextWindow: data.contextWindow,  // 200000
    inputPrice: data.inputPrice,  // 3.0
    outputPrice: data.outputPrice,  // 15.0
    capabilityTags: JSON.stringify(data.capabilityTags),  // ["planning", "code_execution"]
    capabilityScore: JSON.stringify(data.capabilityScore),  // {"planning": 0.95}
    workRoles: JSON.stringify(data.workRoles),  // ["main_chat", "planning"]
  });
}
```

---

## 七、可抄 / 要改 / 不抄 三清单

### 7.1 可抄（直接复用 / 微调）

| 模块 | 来源路径 | Cosmgrid-Agent 落点 | 改动量 |
|---|---|---|---|
| ApiKeyInput 受控组件 + 眼睛按钮 | `forms/ApiKeyInput.tsx:37-66` | `app/src/components/providers/ApiKeyInput.tsx` | 抄结构，把 onChange 改成 RHF `field.onChange` |
| BasicFormFields 三件套布局 | `forms/BasicFormFields.tsx:125-156` | `app/src/components/providers/BasicFormFields.tsx` | 把字段名改成 Cosmgrid-Agent 的（name/notes/website → name/notes/website） |
| UniversalProviderFormModal 状态结构 | `UniversalProviderFormModal.tsx:41-96` | `app/src/components/providers/AddProviderDialog.tsx` | 把 `claude/codex/gemini` Switch 改成 `enabled` Switch，去掉模型分组的 haiku/sonnet/opus |
| zod schema JSON 校验 superRefine | `lib/schemas/provider.ts:42-54` | `app/src/lib/schemas/provider.ts` | 字段替换为 Cosmgrid-Agent 的 |
| eye 按钮 + showApiKey state | `UniversalProviderFormModal.tsx:46, 434-447` | 内联到 ApiCredential 字段块 | 直接抄 |
| 多 Switch 列表 UI（带 icon + label） | `UniversalProviderFormModal.tsx:484-515` | 改造成 WorkRoleSelector 的多 checkbox 列表 | 结构抄，icon 列表换成 WorkRole 元数据 |
| `crypto.randomUUID()` 生成新 id | `UniversalProviderFormModal.tsx:209` | 提交时生成 providerKey 用 | 直接抄（cosmgrid 用 cuid，prisma 自动生成） |
| preset 选择按钮组（带 icon） | `UniversalProviderFormModal.tsx:357-391` | v0.2 暂不做（先支持手填），v0.3 抄 | 留 v0.3 |

### 7.2 要改（CC Switch 概念不能用，Cosmgrid-Agent 重新设计）

| 模块 | 原因 | v0.2 怎么改 |
|---|---|---|
| **workRoles 多选下拉** | CC Switch 没这概念 | 见第 6.2 节方案 A：8 个 checkbox 列表 |
| **测试连接按钮** | CC Switch 在列表里做，不在 form 内 | 见第 5.1 节 |
| **字段组合方式** | CC Switch 是 "1 Provider = 1 settingsConfig JSON"；Cosmgrid-Agent 是 "1 Provider + 1 ApiCredential + N Model" | 把"添加供应商"拆成 3 步 / 一表单多段（见第 8 节实施建议） |
| **图标选择** | Cosmgrid-Agent v0.2 不做 | 跳过，v0.3 再加 |
| **预设系统（claude/codex/gemini）** | Cosmgrid-Agent 不区分 CLI 端，只分 Provider 类型 | 改成 "Provider 类型下拉"（anthropic/openai/google/deepseek/qwen/glm/...） |
| **AppId 路由** | Cosmgrid-Agent 不按 CLI 工具分 | 改成 "一个表单 + workRoles 多选决定这个模型能跑哪些角色" |
| **保存并同步到 Claude/Codex/Gemini 配置** | CC Switch 是切换 CLI 用的，Cosmgrid-Agent 是统一调用 | 删掉，只保存到 SQLite |

### 7.3 不抄（明确排除）

| 模块 | 原因 |
|---|---|
| **本地代理逻辑**（`src-tauri/src/proxy/`，87k 行） | Cosmgrid-Agent v0.x 不做本地代理，靠 Vercel AI SDK 直接调 |
| **claude_desktop_config.rs / codex_config.rs / hermes_config.rs** | 大文件设计，跟"切换 CLI 配置"强绑定，Cosmgrid-Agent 不需要 |
| **流式健康检查**（`stream_check.rs` + `model-test.ts`） | v0.2 用更简单的"测试连接"按钮（generateText 一次 ping） |
| **OAuth 流程**（`claude_mcp.rs`, `CodexOAuthSection.tsx`） | v0.2 只支持手动填 API Key，OAuth 留 v0.3 |
| **DeepLink 导入供应商**（`DeepLinkImportDialog.tsx`，30k） | Cosmgrid-Agent 没有 deeplink 协议需要导入 |
| **ClaudeDesktop / OpenCode / Hermes 子表单** | Cosmgrid-Agent 不分这么多端 |
| **SettingsConfig JSON Editor**（`JsonEditor.tsx`） | Cosmgrid-Agent 不存 JSON 配置 |
| **ProviderMeta 自定义端点**（`custom_endpoints`） | Cosmgrid-Agent v0.2 单一 baseUrl，不做多 endpoint 轮询 |
| **Failover 故障转移** | Cosmgrid-Agent v0.x 不做，留 v0.4 |
| **Tauri-plugin-store / tauri-plugin-deep-link** | Cosmgrid-Agent 用 Prisma + Hono，不用 Tauri store |
| **i18n react-i18next** | Cosmgrid-Agent 暂不做多语言，文案写死中文字符串 |

---

## 七点五、v0.2 落地状态（2026-06-19）

**v0.2 后端已落地**（本报告 v0.2 实施建议章节内容已合到主文档 v0.2 章节）：
- ✅ 后端 LLM 适配层 8 个文件（`server/llm/`）
- ✅ 后端 3 个 API（POST `/api/chat/{stream,sync,test-connection}` + GET `/api/models-filter`）
- ✅ 4 个 Zod schema（`schemas.ts` v0.2 Chat 层）
- ⏳ **前端 7 个组件** —— 留 v0.2 前端阶段
- ⏳ shadcn/ui init（`pnpm dlx shadcn@latest init -d`，**新包名 shadcn 不是 shadcn-ui**）—— 留 v0.2 前端阶段
- ⏳ crypto.ts（Web Crypto AES-GCM + 固定密钥派生）—— 留 v0.2 前端阶段；v0.3 切 `tauri-plugin-keyring` OS keychain

**第 9 节代码片段可直接复制**到 v0.2 前端：
- 9.1 ApiKeyInput（70 行 RHF + 眼睛按钮）
- 9.2 WorkRoleSelector（120 行 8 checkbox grid；前端评审建议改 Popover + cmdk）
- 9.3 TestConnectionButton（100 行 + 调 `server/llm/test-connection.ts`）
- 9.4 crypto.ts（80 行 Web Crypto AES-GCM；v0.2 临时方案，v0.3 切 OS keychain）

**v0.3 留 TODO**（不在 v0.2 范围）：
- ⏳ **OS keychain 加密**（`tauri-plugin-keyring`）替代 Web Crypto 固定密钥
- ⏳ **OAuth 流程**支持（v0.2 仅手动填 API Key）
- ⏳ **Failover 故障转移**（v0.4 项目模板再用）

---

## 八、Cosmgrid-Agent v0.2 实施建议

### 8.1 需要的 React 组件（文件清单）

```
app/src/
├── components/
│   ├── providers/
│   │   ├── AddProviderDialog.tsx         (NEW, 200 行)  顶层弹窗
│   │   ├── ApiKeyInput.tsx               (NEW, 80 行)   API Key 输入（带眼睛按钮）
│   │   ├── BasicFormFields.tsx           (NEW, 100 行)  名称/备注/官网
│   │   ├── WorkRoleSelector.tsx          (NEW, 120 行)  8 个角色多选
│   │   ├── ModelConfigFields.tsx         (NEW, 150 行)  Model 字段（name/displayName/contextWindow/prices/capabilityTags/capabilityScore）
│   │   ├── ProviderTypeSelect.tsx        (NEW, 80 行)   Provider 类型下拉（anthropic/openai/google/...）
│   │   └── TestConnectionButton.tsx      (NEW, 100 行)  测试连接按钮
│   └── ui/                                (新增 shadcn 组件)
│       ├── button.tsx                     (NEW, from shadcn)
│       ├── input.tsx                      (NEW)
│       ├── label.tsx                      (NEW)
│       ├── switch.tsx                     (NEW)
│       ├── checkbox.tsx                   (NEW)
│       ├── dialog.tsx                     (NEW)
│       ├── select.tsx                     (NEW)
│       ├── tabs.tsx                       (NEW)
│       ├── alert.tsx                      (NEW)
│       └── form.tsx                       (NEW, 用 react-hook-form)
├── lib/
│   ├── api.ts                             (NEW, fetch wrapper for Hono API)
│   ├── crypto.ts                          (NEW, encryptApiKey/decryptApiKey)
│   └── schemas/
│       └── provider.ts                    (NEW, zod schemas for form)
├── pages/
│   └── ProvidersPage.tsx                  (NEW, 列表 + 添加按钮)
└── App.tsx                                (新增路由 /providers)
```

### 8.2 Props 接口设计

```typescript
// app/src/components/providers/AddProviderDialog.tsx

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (providerId: string) => void;
}

interface FormValues {
  // Provider 段
  providerName: string;           // "我的 Claude"
  providerType: ProviderType;     // "anthropic" | "openai" | "google" | "deepseek" | "qwen" | "glm" | "custom"
  website: string;                // "https://anthropic.com"
  notes: string;                  // "公司报销的 API Key"

  // ApiCredential 段
  credentialName: string;         // "默认 Credential"
  baseUrl: string;                // "https://api.anthropic.com"
  apiKey: string;                 // "sk-ant-..." (提交前加密)
  enabled: boolean;               // true
  supportsStreaming: boolean;     // true
  supportsFunctionCall: boolean;  // true
  supportsVision: boolean;        // false

  // Model 段（v0.2 限制只填 1 个，可扩展为 N 个）
  modelName: string;              // "claude-sonnet-4-20250514"
  displayName: string;            // "Claude Sonnet 4"
  contextWindow: number;          // 200000
  inputPrice: number;             // 3.0
  outputPrice: number;            // 15.0
  capabilityTags: string[];       // ["planning", "code_execution"]
  capabilityScore: Record<string, number>;  // {"planning": 0.95}
  workRoles: WorkRole[];          // ["main_chat", "planning"]
}
```

### 8.3 Zod Schema 草案

```typescript
// app/src/lib/schemas/provider.ts
import { z } from "zod";

export const WORK_ROLES = [
  "main_chat",
  "planning",
  "review",
  "frontend",
  "backend",
  "testing",
  "final_review",
  "general",
] as const;
export type WorkRole = (typeof WORK_ROLES)[number];

export const PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "glm",
  "custom",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const providerFormSchema = z.object({
  // Provider 段
  providerName: z.string().min(1, "供应商名称必填").max(100),
  providerType: z.enum(PROVIDER_TYPES),
  website: z.string().url("请输入有效网址").or(z.literal("")).optional(),
  notes: z.string().max(2000).optional(),

  // ApiCredential 段
  credentialName: z.string().min(1, "凭据名称必填").max(100),
  baseUrl: z.string().url("请输入有效 API 地址"),
  apiKey: z.string().min(1, "API Key 必填"),
  enabled: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  supportsFunctionCall: z.boolean().default(true),
  supportsVision: z.boolean().default(false),

  // Model 段
  modelName: z.string().min(1, "模型 ID 必填").max(100),
  displayName: z.string().max(100).optional(),
  contextWindow: z.number().int().positive().optional(),
  inputPrice: z.number().nonnegative().optional(),
  outputPrice: z.number().nonnegative().optional(),
  capabilityTags: z.array(z.string()).default([]),
  capabilityScore: z.record(z.string(), z.number().min(0).max(1)).default({}),
  workRoles: z
    .array(z.enum(WORK_ROLES))
    .min(1, "至少选择 1 个工作角色"),
});

export type ProviderFormValues = z.infer<typeof providerFormSchema>;
```

### 8.4 提交逻辑（伪代码）

```typescript
// app/src/components/providers/AddProviderDialog.tsx
import { encryptApiKey } from "@/lib/crypto";

async function onSubmit(values: ProviderFormValues) {
  // 1. 加密 API Key
  const apiKeyEncrypted = await encryptApiKey(values.apiKey, getCryptoKey());

  // 2. 创建 Provider
  const providerRes = await fetch("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: values.providerName,
      type: values.providerType,
      website: values.website || null,
      notes: values.notes || null,
    }),
  });
  const provider = await providerRes.json();
  if (!providerRes.ok) throw new Error(provider.error);

  // 3. 创建 ApiCredential
  const credRes = await fetch("/api/api-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: values.credentialName,
      baseUrl: values.baseUrl,
      apiKeyEncrypted,
      enabled: values.enabled,
      supportsStreaming: values.supportsStreaming,
      supportsFunctionCall: values.supportsFunctionCall,
      supportsVision: values.supportsVision,
      defaultModelId: null, // 第 4 步创建 Model 后回填
    }),
  });
  const credential = await credRes.json();

  // 4. 创建 Model
  const modelRes = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: provider.data.id,
      name: values.modelName,
      displayName: values.displayName || null,
      contextWindow: values.contextWindow || null,
      inputPrice: values.inputPrice || null,
      outputPrice: values.outputPrice || null,
      capabilityTags: JSON.stringify(values.capabilityTags),
      capabilityScore: JSON.stringify(values.capabilityScore),
      workRoles: JSON.stringify(values.workRoles),
    }),
  });
  const model = await modelRes.json();

  // 5. 回填 defaultModelId
  await fetch(`/api/api-credentials/${credential.data.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultModelId: model.data.id }),
  });

  toast.success("供应商添加成功");
  onSuccess?.(provider.data.id);
  onOpenChange(false);
}
```

### 8.5 测试连接后端设计（v0.2 新增）

**Tauri command**（`app/src-tauri/src/commands/test_connection.rs`，**新文件**）：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct TestConnectionRequest {
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub provider_type: String,  // "anthropic" | "openai" | "google" | ...
}

#[derive(Debug, Serialize)]
pub struct TestConnectionResponse {
    pub success: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub model_response: Option<String>,
}

#[tauri::command]
pub async fn test_provider_connection(req: TestConnectionRequest) -> TestConnectionResponse {
    // 1. 构造 1 个最小请求（"ping" / "hi"）
    // 2. 调对应 provider 的 SDK，发出去
    // 3. 10s 超时
    // 4. 返回 success / latency / error
}
```

**前端调用**（`app/src/lib/api/test-connection.ts`）：

```typescript
import { invoke } from "@tauri-apps/api/core";

export async function testProviderConnection(params: {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  providerType: string;
}): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  return invoke("test_provider_connection", { req: params });
}
```

### 8.6 shadcn/ui 初始化（v0.2 前置步骤）

```bash
cd /Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/app
npx shadcn-ui@latest init
# 选 "Default" 风格 + "Slate" 颜色
# 选 src/components/ui 目录
# 选 yes for CSS variables

npx shadcn-ui@latest add button input label switch checkbox dialog select tabs alert form
```

需要的 9 个 shadcn 组件（见 8.1 文件清单）。

---

## 九、代码片段（直接抄 / 微调即可用）

### 9.1 ApiKeyInput（直接抄，改 RHF）

```tsx
// app/src/components/providers/ApiKeyInput.tsx
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  label?: string;
  id?: string;
}

export function ApiKeyInput({
  value,
  onChange,
  placeholder = "sk-...",
  required = false,
  label = "API Key",
  id = "apiKey",
}: ApiKeyInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          autoComplete="off"
          className="pr-10"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3"
            onClick={() => setShow(!show)}
            aria-label={show ? "隐藏" : "显示"}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        )}
      </div>
    </div>
  );
}
```

**来源对照**：CC Switch `ApiKeyInput.tsx:37-66`，改受控 props 为 RHF 友好（保留 onChange 模式，不用 FormField），加 `required` 红色星号，placeholder 默认 `sk-...` 不变。

### 9.2 WorkRoleSelector（Cosmgrid-Agent 独有，基于 CC Switch Switch 列表改造）

```tsx
// app/src/components/providers/WorkRoleSelector.tsx
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { WorkRole } from "@/lib/schemas/provider";
import { WORK_ROLES } from "@/lib/schemas/provider";

const WORK_ROLE_META: Record<WorkRole, { label: string; description: string }> = {
  main_chat:    { label: "主对话",    description: "用户跟 AI 的直接对话" },
  planning:     { label: "计划阶段",  description: "任务分解、架构设计" },
  review:       { label: "代码 review", description: "PR/代码审查" },
  frontend:     { label: "前端实现",  description: "UI/CSS/组件" },
  backend:      { label: "后端实现",  description: "API/DB/服务" },
  testing:      { label: "测试",      description: "单测/集成测试" },
  final_review: { label: "最终审核",  description: "完整方案复核" },
  general:      { label: "通用兜底",  description: "无明确角色时" },
};

interface WorkRoleSelectorProps {
  value: WorkRole[];
  onChange: (roles: WorkRole[]) => void;
}

export function WorkRoleSelector({ value, onChange }: WorkRoleSelectorProps) {
  const toggle = (role: WorkRole) => {
    onChange(value.includes(role) ? value.filter(r => r !== role) : [...value, role]);
  };
  return (
    <div className="space-y-2">
      <Label>工作角色 <span className="text-destructive">*</span></Label>
      <div className="grid grid-cols-2 gap-2">
        {WORK_ROLES.map((role) => (
          <label
            key={role}
            className="flex items-start gap-2 p-3 rounded border cursor-pointer hover:bg-accent transition-colors"
          >
            <Checkbox
              checked={value.includes(role)}
              onCheckedChange={() => toggle(role)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">{WORK_ROLE_META[role].label}</div>
              <div className="text-xs text-muted-foreground">
                {WORK_ROLE_META[role].description}
              </div>
            </div>
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <Alert variant="destructive">
          <AlertDescription>至少选择 1 个工作角色</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
```

**来源对照**：CC Switch `UniversalProviderFormModal.tsx:484-515`（多 Switch 列表），把 Switch 改成 Checkbox，加 description 文字。

### 9.3 TestConnectionButton（v0.2 新增，不抄 CC Switch）

```tsx
// app/src/components/providers/TestConnectionButton.tsx
import { useState } from "react";
import { Loader2, Zap, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { testProviderConnection } from "@/lib/api/test-connection";

interface Props {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  providerType: string;
  disabled?: boolean;
}

export function TestConnectionButton({ baseUrl, apiKey, modelName, providerType, disabled }: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; latencyMs?: number; error?: string } | null>(null);

  const handleClick = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await testProviderConnection({ baseUrl, apiKey, modelName, providerType });
      setResult(res);
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const canTest = !disabled && baseUrl && apiKey && modelName && !testing;

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={handleClick} disabled={!canTest}>
        {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
        {testing ? "测试中..." : "测试连接"}
      </Button>
      {result && (
        <Alert variant={result.success ? "default" : "destructive"}>
          <div className="flex items-center gap-2">
            {result.success ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertDescription>连接成功，延迟 {result.latencyMs}ms</AlertDescription>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4" />
                <AlertDescription>连接失败：{result.error}</AlertDescription>
              </>
            )}
          </div>
        </Alert>
      )}
    </div>
  );
}
```

### 9.4 crypto.ts（AES-GCM 加密，v0.2 简化方案）

```typescript
// app/src/lib/crypto.ts
// v0.2 简化方案：固定密钥派生（v0.3 切到 keychain）
// ⚠️ 警告：此方案密钥在源码里，逆向可破。生产环境必须用 OS keychain。

const PASSPHRASE = "cosmgrid-agent-v0.2-fixed-passphrase"; // TODO: v0.3 改成从 keychain 读

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(PASSPHRASE),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  cachedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("cosmgrid-agent-v0.2-salt"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedKey;
}

export async function encryptApiKey(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  // 拼接 iv + ciphertext → base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptApiKey(b64: string): Promise<string> {
  const key = await getKey();
  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
```

---

## 十、质量自检（v0.2 已完成，v0.2 前端阶段参考）

从"v0.2 开发者照着写代码"角度检查：

- [x] 字段清单表（第三节）—— v0.2 前端直接照搬字段名
- [x] Zod schema 草案（8.3 节）—— v0.2 后端已搬到 `schemas.ts`，前端沿用
- [x] Props 接口（8.2 节）—— TypeScript 类型完整
- [x] 4 个核心组件代码片段（第九节）—— v0.2 前端直接复制
- [x] 提交逻辑伪代码（8.4 节）—— v0.2 后端用 `loadChatContext` helper 实现，提交调 3 个 API
- [x] Tauri command 设计（8.5 节）—— v0.2 后端用 Hono 路由替代 Rust command
- [x] shadcn/ui 初始化命令（8.6 节）—— **改用 `pnpm dlx shadcn@latest init -d`**（新包名）
- [x] 新增 workRoles 设计（第六节）—— 8 个枚举值 + UI 草图
- [x] 加密方案（4.3 节）—— 4 个方案对比 + 简化代码（**v0.2 用方案 B 固定密钥**；**v0.3 切方案 C OS keychain**）

**没有覆盖到的盲点**（v0.2 仍要做）：
- ⏳ 前端 7 个组件实际实现（v0.2 前端阶段，详见第 8 节）
- ⏳ AddProviderDialog 串起 3 个 API 调用（v0.2 前端阶段）
- ⏳ 测试连接按钮 debounce + 服务端限流（v0.2 前端阶段 + 留 v0.2 后端 TODO）

---

## 附录 A：参考文件路径速查

> **2026-06-19 更新**：附录 A 与第二节"组件位置"内容重复，路径以第二节为准。

| 用途 | CC Switch 路径 | 行数 |
|---|---|---|
| 顶层弹窗入口 | `src/components/providers/AddProviderDialog.tsx` | 377 |
| 实际表单（按 appId 路由） | `src/components/providers/forms/ProviderForm.tsx` | 83k（超级大文件） |
| API Key 输入控件 | `src/components/providers/forms/ApiKeyInput.tsx` | 70 |
| 统一供应商表单（v0.2 主抄） | `src/components/universal/UniversalProviderFormModal.tsx` | 720 |
| 编辑供应商弹窗 | `src/components/providers/EditProviderDialog.tsx` | 255 |
| Zod schema | `src/lib/schemas/provider.ts` | 61 |
| 流式健康检查 API | `src/lib/api/model-test.ts` | 65 |
| DAO 存储（settings_config 整个 JSON 化） | `src-tauri/src/database/dao/providers.rs:240-264` | - |
| 通用 FullScreenPanel 容器 | `src/components/common/FullScreenPanel.tsx`（推测） | - |

## 附录 B：Cosmgrid-Agent 关键文件路径

| 文件 | 当前状态 |
|---|---|
| `app/prisma/schema.prisma` | ✅ 14 张表已定义，workRoles 字段在 Model:97 |
| `app/server/schemas.ts` | ✅ zod schema 已就位，workRoles 校验已存在 |
| `app/server/index.ts` | ✅ Hono API + 4 资源层 CRUD + 5 任务层 CRUD |
| `app/server/routes/factory.ts` | ✅ createCrudRouter 通用工厂 |
| `app/src/components/ui/` | ❌ **未装 shadcn/ui**，需 `npx shadcn-ui@latest init` |
| `app/src/pages/ProvidersPage.tsx` | ❌ **未存在**，v0.2 新建 |
| `app/src/lib/crypto.ts` | ❌ **未存在**，v0.2 新建 |
| `app/src/components/providers/` | ❌ **整个目录未存在**，v0.2 整目录新建 |
