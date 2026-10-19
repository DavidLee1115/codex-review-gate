# Review Gate 验证状态语义

生效日期：2026-10-05。报告 schema 从 3 升为 4；保留已有 verdict 与退出码，不新增验证器或 Python 自动执行入口。

**不存在证据 ≠ PASS；没有运行 ≠ FAIL。Review Gate APPROVE ≠ Release Gate PASS。**

## 检查状态

| 状态 | 定义 | 当前 CLI 的产生条件 |
| --- | --- | --- |
| PASS | 实际执行且成功 | npm 进程启动，正常完成，exit 0，未触发超时或输出保留上限。仅说明脚本完成，不保证有有效测试或覆盖改动。 |
| FAIL | 实际执行且失败 | 命令完成，非零退出，且未被识别为 runner 阻断。保留退出码和错误摘要；命令失败不自动证明产品回归或由本次 diff 引起。 |
| SKIP | 根据明确配置不适用 | 保留这一状态供类型与判定层表达明确不适用；现有 CLI 没有不适用配置，因此不会自动产生 SKIP。本轮不增加配置系统。 |
| BLOCKED | 应执行但环境、依赖、权限或 runner 限制使其无法执行或完整取证 | manifest 读取 / 解析 / scripts 结构异常、声明的命令无效、npm 无法启动、shell 126/127 加明确工具无法执行诊断、进程超时 / 非正常终止、exit 0 但输出超过 128 KB。可能执行过部分检查。 |
| NOT_RUN | 当前流程没有执行该检查，无资格下成功或失败结论 | 没有根 package.json、未声明相应 script、Python / 其他非 Node 验证不在自动发现范围。不是“不适用”的同义词。 |

## 真实执行与状态分别记录

每项保留 `command`、`exitCode`、`durationMs`、`errors`，新增：

- `executed`：npm 进程是否真实启动。false 不会产生 PASS/FAIL；true 不保证 script 内的 validator 或每个测试都运行过。
- `reason`：状态原因。没有 command 时也显示原因，不再统一显示“script unavailable”。
- `outputTruncated`：是否触发输出保留上限。成功退出但信息不完整为 BLOCKED；已经正常非零退出仍保留 FAIL，不因截断免除已知失败。

Python 项目即使有 tests、pyproject.toml 或历史 Python PASS，本次仍是 NOT_RUN。若仓库主动声明 npm script 执行 Python 或外部 validator，则记录该真实命令结果，但不会自动把整个 Python 项目或外部服务标成通过。

工具启动归因仅使用 spawn 错误或 shell 保留退出码 126/127 与对应诊断的组合。单独 exit 127、日志出现任意 “permission” / “not found” 字样不会把普通失败变成 BLOCKED。嵌套工具以通用 exit 1 报环境错误时，当前 CLI 不能可靠自动区分环境与断言，保留命令 FAIL 并要求人工归因；没有增加关键词免除或模型判定器。无法自动归因不等于已确认产品缺陷。

Jev 不属于这五项验证器：`jev.status` 的 available / not_requested / failed 是辅助 adapter 状态，不能当作测试 PASS/FAIL。

## Verdict 与状态的关系

1. 明确的确定性负面证据或完成的命令 FAIL → REJECT。必须查看具体证据，不能推断整个 app 已失败。
2. 没有负面证据，但有非 LOW 风险、BLOCKED、行为改动无 passing test、无待审 diff、大 diff 或 Jev 请求人工审查 → REVIEW。
3. 没有上述门槛，当前证据足以支持有限审查范围 → APPROVE。纯文档 / 样式 LOW 可无 test 批准；未配置的可选 lint / typecheck / build / verify 不自动阻断这种批准，但逐项保留 NOT_RUN。

HIGH、缺可选测试、不确定性、大 diff 均不自动 REJECT。SKIP 从不成为正面或负面验证证据；对行为改动，单靠 SKIP 仍不能代替 passing test。风险等级独立于验证结果，LOW 改动也可因失败命令 REJECT。

## 报告与兼容

文本和 JSON 均携带审查范围及推荐下一步；文本单独展示 missing / blocked validation、positive / negative evidence、uncertainty、required human action。静态 evidence 的 `source=deterministic` 与命令 evidence 的 `source=validation` 不混用。

schema v4 增加 BLOCKED / NOT_RUN enum 和上述字段，以及 `reviewScope` / `recommendedNextStep`。封闭 v3 消费者必须升级，不允许把未知状态默认映射为 PASS。历史 `dogfood/report.*` 不改写：其中没有执行的 Python 验证曾写 SKIP，应作为历史未验证记录理解。当前状态模型没有读取历史报告并重新认证的功能。

Review Gate 的命令结果不复用为 Release Gate 的受控运行结果。发布候选还需按 Release Gate 的 profile、源码绑定、真实行为断言和覆盖缺口单独验收；两者的全局 verdict 词汇不同。
