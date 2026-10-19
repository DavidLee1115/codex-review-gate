# Review Gate 职责与使用入口

核对日期：2026-10-05。依据当前 CLI、规则、验证器、报告模型、测试、benchmark、历史 dogfood，以及 local-app-release-gate 的 `GATE_RESPONSIBILITY.md` 和 `VERDICT_SEMANTICS.md`。

**Review Gate 审查当前 Git 工作树的代码 / diff 风险，并记录本次实际执行的工程检查。它给出审查建议，不证明应用已经完成运行验收。Review Gate APPROVE 不等于 Release Gate PASS。**

## 实际检查什么

- 读取当前分支、HEAD、Git status，以及 staged、unstaged、untracked 改动；重命名保留旧路径。当前没有 commit range / PR URL 入口，clean tree 没有待审改动，给出 REVIEW。
- 根据变更路径、增加 / 删除的文本和 Git 状态，识别认证、权限、数据结构、依赖、部署、文件写入 / 删除、子进程、外部网络、持久化、恢复 / 导出、配置、错误处理等风险。
- 识别未解决冲突、明确危险模式和疑似凭据；具体命中及证据归类见 `src/risk.ts` 与报告。文本规则不是完整程序分析，命中需要结合上下文审查。
- 发现根目录项目标记；仅自动执行根 `package.json` 中已有的 `test`、`lint`、`typecheck`、`build`、`verify` 脚本。记录实际命令、状态、退出码、耗时和有限错误摘要。
- 工程检查后再次读取工作树；若脚本改变了被审内容，报告新状态并要求复核。
- 将 positive evidence、negative evidence、uncertainty、risk signals 分开，结合风险和验证缺口输出 APPROVE / REVIEW / REJECT、人工行动与下一步。

它包含静态 diff 审查和有限的实际工程验证，不能把整个工具称为“纯静态检查”。

## 不检查什么

- 不自动启动应用、操作浏览器、检查实际导出内容或验证 backup / restore 往返数据。
- 不保证外部服务、真实账号、生产环境或用户完整流程可用。
- 不代替人工视觉 / 交互验收、用户价值验证、客户确认或市场验证。
- 不自动发现并执行 Python、Rust、Go、Makefile 等验证命令，也不把项目标记视为对应语言已经验证。
- 不证明测试覆盖了改动；存在 test 文件、脚本名叫 `test` 或命令成功都不是覆盖率证明。仓库脚本也可能只是空操作。
- 不全面分析未改动代码、忽略文件、二进制内容或超出读取上限的 diff；不自动修代码、安装目标依赖或发布版本。

仓库自带 npm script 可以运行浏览器或 Python，但本工具只知道该脚本的执行结果。除非另行检查具体断言和产物，不据此宣称浏览器流程、Python 全套测试或发布验收通过。

## 静态证据与运行证据

| 报告内容 | 证据来自哪里 | 可以说明什么 |
| --- | --- | --- |
| changedFiles / diffStats / projectFiles | Git 与文件读取 | 哪些工作树文件变化、发现哪些项目标记；不说明功能正常。 |
| riskLevel / risks / deterministic evidence | 路径与 diff 规则 | 风险信号、明确规则命中、有限审查范围；HIGH 不等于 REJECT。 |
| validations 中的 PASS / FAIL | 本次实际执行的仓库工程命令 | 对应命令成功 / 失败；仍需看命令内容、失败归因与覆盖范围。 |
| SKIP / BLOCKED / NOT_RUN | 明确不适用声明、执行前提或未执行记录 | 检查没有提供成功证据；不代表 PASS，也不把未执行当作 FAIL。 |
| Jev 建议 / 排序 | 可选 adapter 的第二意见 | 提醒人工关注路径或问题；不成为确定性负面证据或最终 verdict 的唯一依据。 |
| app 启动、浏览器、恢复、导出、外部依赖正常 | 需要对应的真实测试、运行断言和产物 | 本工具默认不提供；需要 Release Gate 的适配范围或专门人工 / 工程验收。 |

状态的精确定义与兼容说明见 [VALIDATION_STATUS_SEMANTICS.md](VALIDATION_STATUS_SEMANTICS.md)。不存在证据不等于 PASS，没有运行不等于 FAIL。

## 只用 Review Gate

适合提交前的代码、配置、PR / diff 风险检查，且当前任务不要求运行验收。CLI 审查本地工作树，PR 需要先在独立 checkout 中准备对应待审改动；传入 PR 地址或一个已经 clean 的提交不会自动生成 PR diff。

```sh
REVIEW_GATE_JEV_ADAPTER= node dist/cli.js /absolute/path/to/repository
```

这个入口显式关闭可选 Jev adapter，并仍会运行仓库声明的工程 scripts。它在目标仓库执行，不提供 Release Gate 的隔离运行环境；陌生仓库应先审查 scripts 的实际行为。

APPROVE 仅支持当前有限审查范围。REVIEW 要求完成报告列出的人工检查、关键验证或环境修复；REJECT 要求处理明确负面证据后重跑。

## 只用 Release Gate

已有代码候选，仅需验证启动、浏览器流程、持久化、重启、恢复、导出时，使用 local-app-release-gate 已审核的 profile 与实际受支持的 runtime。

```sh
./release-gate.sh /absolute/path/to/project --profile /absolute/path/to/reviewed-profile.json --report-dir /absolute/path/to/new-report-directory
```

按该 Gate 的 profile、源码绑定和报告判断覆盖范围。没有待审 diff 时，不机械追加 Review Gate。Release Gate PASS 仍仅覆盖实际声明并执行的检查，不能抹去代码风险、人工未验收或市场未知。

## 两个都用

真正准备发布、且含代码改动的 app 版本：

1. 提交前用 Review Gate 审查工作树，处理负面证据与必需人工行动。
2. 确定候选版本后，用 Release Gate 对已审核 profile 绑定的源码执行实际行为验收。
3. 同时保存两个结论、所审改动 / commit 和 Release Gate 源码 hash。候选变动后，旧结果不能替新内容背书。

两个 Gate 都可能执行工程测试，这是实际重叠。Review Gate 在目标仓库执行 npm scripts，Release Gate 在受控副本中执行其命令与运行断言；环境、源码绑定和覆盖范围不同。本轮没有跨 Gate 自动复用结果或跳过门槛的机制。

## 两个都不需要

纯文档的小修、一次性非执行资产、没有代码或运行验收要求的文字工作，可以直接人工检查。若文档包含命令、凭据示例或运行配置，按实际风险决定是否用 Review Gate。人工视觉、真实用户与市场验证应走各自的真实验收，不因为两个 Gate 未覆盖就补一个形式化 PASS。

## 容易误解的字段与历史记录

- `verdict: APPROVE` 和 exit 0 是当前改动审查建议，不是“应用验收成功”或发布授权。
- `riskLevel: HIGH` 是人工关注强度；无明确负面证据时保持 REVIEW，不能因风险高直接 REJECT。
- `positiveEvidence` 同时含静态观察和实际命令结果，应看 `source` 与 detail；“只改了文档 / 样式”不是运行测试通过。
- `test: PASS` 只证明记录的脚本成功，不能推断测试数量、有效断言或覆盖面。
- `projectFiles` 发现 `pyproject.toml` / `requirements.txt`，不代表运行了 Python 验证。
- 历史 schema v3 将缺脚本、非 Node 验证未执行及 manifest 读取失败混在 SKIP；旧 `dogfood/report.*` 保留原始记录，不能按本轮规范重新解释成明确不适用。历史缺证据必须保留为未验证。
- `humanReviewItems` 为空不等于人工已验收；`jev.status: available` 仅表示 adapter 返回了可解析结果。
- 历史 10/10 校准和后续 13-case benchmark 是构造案例上的规则校准；不能替代真实项目回归或证明跨项目准确率。

## Jev 与付费边界

`src/jev.ts` 仅在非空 `REVIEW_GATE_JEV_ADAPTER` 环境变量指向可执行程序时调用一次 adapter；没有内置付费 API 调用、自动重试或从 Codex MCP 配置自动启用的路径。失败、超时、无效输出保留诊断，确定性 Review Gate 继续工作。Jev 可增加 REVIEW 请求，不能独立创建 REJECT，也不能覆盖确定性负面证据为 APPROVE。

环境变量会被继承；若 shell 已设置了付费 adapter，普通 CLI 运行也会调用它。需要零付费调用的检查应显式设置 `REVIEW_GATE_JEV_ADAPTER=`。adapter 负责自身发送范围和预算，不能把“可选”理解成自动免费。仓库历史观察 adapter 只回放已记录、经内容 digest 绑定的结果，不产生新远程调用。

## Review Gate 自身如何验收

本轮适合用真实 CLI 入口的临时 Git 仓库测试、完整工程测试、现有 benchmark 和独立来源的真实回归案例验收。local-app-release-gate 当前受控运行入口主要面向网页和 Python HTTPServer，现有 profile 没有此 Node CLI 的专用契约；不能为了得到 PASS 为它改宽标准或新增无消费者需求的 adapter。

没有对应 Release Gate profile 时，CLI 验证结果与运行覆盖限制如实保留，不声称已取得 Release Gate PASS。

## 核对依据

- `src/inspect.ts`、`src/validate.ts`、`src/risk.ts`、`src/verdict.ts`：读取范围、工程执行、规则和裁决。
- `src/cli.ts`、`src/types.ts`、`src/report.ts`、`src/jev.ts`：真实入口、报告模型、展示与辅助调用。
- `test/cli.test.mjs`、`benchmark/run.mjs`、`dogfood/NOTES.md`、`dogfood/report.json`：构造 fixture 与真实历史校准的区别。
- Git `e70bfff`、`381b9a7`、`5407145`：MVP、HIGH / verdict 校准及报告硬化历史。
- `../../local-app-release-gate/GATE_RESPONSIBILITY.md`、`../../local-app-release-gate/VERDICT_SEMANTICS.md`、其 README 与 profiles：跨 Gate 分工、实际运行范围与证据语义。
