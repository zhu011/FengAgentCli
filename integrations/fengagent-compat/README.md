# fengagent-compat（方向 B / P4）

DSH 插件：让 **FengAgentCli 插件跑进 dsh**——把 `@fengagent/*` 的工具契约面
（`ToolDefinition`：`inputSchema` + `execute(input, context)`）挂到 dsh 的
`ctx.tools` 上，适配后进入 dsh 的真实工具注册表，dsh agent 一视同仁地调用。
与方向 A（`packages/dsh-compat`，dsh 插件进 FengAgentCli）互为镜像。

## 原理

- `ctx.tools.register(fengTool)` 判别式补丁：feng 形状 → `adaptFengTool`
  适配（schema 转换 + execute/result 桥接）后注册，返回 dsh 原生 disposer；
  dsh 原生定义（defineTool 产物）照旧直通；
- **补丁必须打在裸服务实例上**：`ctx.tools` 经 cordis traced-proxy 暴露，
  其 set 陷阱会把 `service.register = fn` 写到一次性 shadow receiver——
  先经 `Symbol.for("cordis.original")` 逃生口取裸实例再赋值；
- **feng 插件由本插件装载**（`config.plugins`），不与补丁并列挂 profile：
  兄弟 fiber 的 apply 顺序是异步竞态（实测并列时 feng 插件可能先于补丁
  执行，直接打到未适配的 register 上报 output 校验错）。本插件先打补丁、
  再按列表顺序 `ctx.plugin()` 装载，次序确定（与方向 A 的 loadDshPlugin 同构）。

## schema 转换（feng inputSchema → dsh parameters）

feng 用 zod v3（无 `toJSONSchema` 实例方法），适配顺序：

1. 鸭子 `toJSONSchema()`（zod v4 / dsh-compat 直通 schema）→ 直通规整；
2. zod v3（`_def` 标记）→ `zod-to-json-schema` 转换（去 `$schema`、
   `additionalProperties` 显式化）；
3. 裸 JSON schema 对象（object 根）→ 规整直通；
4. 回退宽松 schema（LLM 从 description 推断——与 feng providers 对
   zod v3 的现状同底，见「已知问题」）。

## 安装与配置

```bash
cd integrations/fengagent-compat && npm pack
dsh plugin --profile <name> add /path/to/fengagent-compat-<ver>.tgz
# feng 插件包（FengAgentCli 形状）也装进 profile 依赖（只作模块解析，不进 bundles）
dsh plugin --profile <name> add /path/to/<feng-plugin>.tgz
```

profile 用户层 `cordis.patch.yml` 配置装载列表：

```yaml
- id: fengagent-compat
  config:
    plugins:
      - <feng-plugin 包名>        # 或模块路径
    configs:                       # 可选：各插件的 config
      <feng-plugin 包名>: { ... }
```

## 已知问题（记录在案）

- ~~**feng providers 的 zod v3 空洞**~~（已修）：`zodToJsonSchemaCompat` 现在先试
  实例自带的 `toJSONSchema()`，zod v3（带 `_def`）走 `zod-to-json-schema`
  （`packages/llm/src/providers/schema.ts` 共享实现，三个 provider 统一）——
  feng 原生工具的 LLM 可见参数不再是空 schema。本插件 dsh 侧的转换保留，
  两条路径行为一致。
- dsh 侧更高阶 feng 服务面（model/storage/context…）不在本版——feng 插件
  目前限「注册工具」型。

## 测试

```bash
cd integrations/fengagent-compat && bun install && npm test   # node --test，13 例
```

E2E（真实 dsh）：`test/fixture-feng-plugin/` 为 feng 形状夹具，装入 profile
后 boot 应见 `[fengagent-compat] feng tool registered: hello_feng`。
