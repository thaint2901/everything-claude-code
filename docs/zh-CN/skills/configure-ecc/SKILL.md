---
name: configure-ecc
description: 评估某个仓库真正需要哪些 ECC 技能和规则 — 基于证据给出候选清单并说明排除理由 — 然后安装该清单并针对项目进行定制。
origin: ECC
---

# 配置 Everything Claude Code (ECC)

决定**这个**仓库需要哪些 ECC 技能和规则，然后只安装这份清单。

本技能的产出是**评估结果**：一份有理由支撑的选择，以及被排除项的理由。安装超出仓库所需的技能是实实在在的成本 — 每个已安装的技能都会在每次会话中消耗上下文 — 因此"排除"与"选择"同样是交付物。

## 何时激活

- 用户说 "configure ecc"、"install ecc"、"setup everything claude code" 或类似表述
- 用户想决定这里值得安装哪些 ECC 技能或规则
- 仓库已发生变化，用户想重新评估现有的 ECC 安装
- 用户想验证、修复或定制现有的 ECC 安装

## 本技能不做什么

`/project-init` 已经能检测项目技术栈、从清单文件解析安装计划、执行 dry-run 并在批准后才写入。**不要重复实现这些。** 调用它，并把它的输出作为证据使用。

本技能负责 `/project-init` 不做的两件事：

1. **判断** — 技术栈映射是机械的。它无法得出"这个仓库用 Python，但没有 Web 层，所以 `fastapi-patterns` 在这里是噪音"这样的结论。
2. **定制** — 把已安装的文件裁剪到这个项目真正用得上的内容。

## 先决条件

此技能必须在激活前对 Claude Code 可访问。有两种引导方式：

1. **通过插件**: `/plugin install ecc@ecc` — 插件会自动加载此技能
2. **手动**: 仅将此技能复制到 `~/.claude/skills/configure-ecc/SKILL.md`，然后通过说 "configure ecc" 激活

---

## 步骤 0：定位 ECC 源

优先使用用户已有的本地检出。克隆远程仓库是兜底手段，绝不是默认做法。

```bash
# 1. 当前是否就在 ECC 仓库内？
git rev-parse --show-toplevel 2>/dev/null

# 2. 作为插件安装的？使用插件根目录。
# 3. 仅当以上都不可用，且已告知用户之后：
git clone https://github.com/affaan-m/everything-claude-code.git /tmp/everything-claude-code
```

将 `ECC_ROOT` 设置为找到的那个源。

如果用户使用的是 fork，本地检出才是正确的源 — 克隆上游会静默地装上他们并未在运行的代码。克隆任何东西之前先询问。

---

## 步骤 1：从清单文件构建候选集

```bash
node "$ECC_ROOT/scripts/install-plan.js" --list-components --family skill --json
```

**永远不要在本文件中硬编码技能列表。** 任何写在这里的列表，在新增一个技能的那一刻就已过期；而硬编码列表会悄悄缩小候选集 — 只能看到一小部分候选项的评估，不算评估。

规则同理：在运行时枚举 `$ECC_ROOT/rules/*/`，而不是在这里罗列语言名。

---

## 步骤 2：为每个候选项补充信息

仅靠清单文件不足以判断一个技能。每个 component 只携带 `id`、`family`、`description`、`moduleIds`、`moduleCount` 和 `targets`。评估前先补上另外两个信号：

**来源** — 从 `$ECC_ROOT/skills/<id>/SKILL.md` 读取 `metadata.origin`。实际出现的取值包括 `ECC`（第一方）、`community`、厂商或个人贡献者，还有若干技能完全没有声明来源。第一方技能与单一厂商的领域技能不应作为等价的推荐项呈现。

**成熟度** — 从 `$ECC_ROOT/manifests/install-modules.json` 中拥有该技能的模块读取 `stability`。取值为 `stable` 和 `beta`。推荐时要标出 `beta`。

**遗留状态 — 已知局限。** 清单文件中不存在任何 `deprecated` 字段，也没有技能的生命周期策略。唯一可用的信号是描述中的自由文本，因此匹配 `legacy`、`superseded` 和 `prefer <other-skill>`，并把结果视为*不完整*。在报告中如实说明，而不要让人以为这项检查是穷尽的。目前它唯一能捕捉到的案例是 `continuous-learning`，已被 `continuous-learning-v2` 取代。

---

## 步骤 3：从仓库收集证据

运行 `/project-init --dry-run`，保留它检测到的技术栈证据和解析出的计划。

交叉参考 `$ECC_ROOT/config/project-stack-mappings.json`，它把项目指示文件映射到 ECC 的技能、规则、钩子和命令。

然后通过阅读仓库，越过映射所能表达的范围：

- 被映射到的框架中，哪些是真正在用的，哪些只是作为传递依赖存在？
- 仓库是否具备某个技能所假定的那一层 — Web 层、数据库层、CI 流水线、UI？
- 已有的 `CLAUDE.md`、`.claude/rules/` 或团队既有规范，是否已经覆盖了该技能要补充的内容？
- 测试和构建脚本说明了这个团队实际是怎么工作的？

**不要询问用户的技术栈是什么。** 仓库本身就能回答，而发问本身就说明评估被跳过了。

---

## 步骤 4：在预算约束下评估

每个已安装的技能都会在每次会话中消耗上下文。把候选清单当作受预算约束的，而不是"把所有可能沾边的都选上"。

对每个候选项记录：找到的证据、推荐结论、以及理由。只有当仓库中有具体信号支撑时才推荐某个技能。"这个项目是 Python"足以支撑 `python-patterns`，但不足以支撑 Python 生态里的每一个技能。

与已经在做这类度量的技能组合使用，而不是重新发明：

- `context-budget` — 审计技能、规则、agent 和 MCP server 的上下文消耗
- `skill-stocktake` — 审计已安装技能和命令的质量

如果仓库已有 ECC 安装，与之做差异对比：对于支撑证据已经消失的技能，要推荐移除，而不只是推荐新增。

---

## 步骤 5：报告评估结果

在安装任何东西**之前**先呈现评估结果：

```text
## ECC 评估 — <repo>

### 检测到的证据
- <信号> -> <它意味着什么>

### 推荐安装 (N)
| 技能 | 来源 | 成熟度 | 证据 | 理由 |

### 明确排除 (M)
| 技能 / 分组 | 排除理由 |

### 未能评估
- <现有数据无法判断的项，包括遗留状态检测的缺口>
```

排除表不是凑数。它是"确实做过决定"的记录，也是让下一次运行变成差异对比、而不是重新猜一遍的依据。

然后用 `AskUserQuestion` 确认这份清单。只针对清单发问，绝不要罗列完整候选集 — 那放不下，而且呈现它本身就违背了评估的意义。

---

## 步骤 6：选择安装级别

使用 `AskUserQuestion`：

```text
问题: "所选组件应安装到哪里？"
选项:
  - "用户级 (~/.claude/)" — "适用于你所有的 Claude Code 项目"
  - "项目级 (.claude/)" — "仅适用于当前项目"
  - "两者" — "通用/共享项放用户级，项目特定项放项目级"
```

设置目标目录：

- 用户级: `TARGET=~/.claude`
- 项目级: `TARGET=.claude`（相对于当前项目根目录）
- 两者: `TARGET_USER=~/.claude`, `TARGET_PROJECT=.claude`

```bash
mkdir -p $TARGET/skills $TARGET/rules
```

---

## 步骤 7：安装清单

对每个已批准的技能，从正确的源根目录复制整个技能目录：

```bash
# 核心技能位于 .agents/skills/
cp -R "$ECC_ROOT/.agents/skills/<skill-name>" "$TARGET/skills/"

# 其余技能位于 skills/
cp -R "$ECC_ROOT/skills/<skill-name>" "$TARGET/skills/"
```

在遍历通配得到的源目录时，绝不要把带尾斜杠的源路径直接传给 `cp`。显式使用目录名作为目标名：

```bash
cp -R "${src%/}" "$TARGET/skills/$(basename "${src%/}")"
```

复制整个目录，而不只是 `SKILL.md` — 有几个技能在其旁边附带 `config.json`、钩子或脚本（`continuous-learning`、`continuous-learning-v2`）。

安装评估选中的规则目录，保留按语言划分的布局：

```bash
cp -r "$ECC_ROOT/rules/common" "$TARGET/rules/common"
cp -r "$ECC_ROOT/rules/<language>" "$TARGET/rules/<language>"
```

语言规则是对通用规则的扩展。如果评估选中了某语言却没选 `common`，要说明这一点并建议补上。

---

## 步骤 8：验证安装

```bash
ls -la $TARGET/skills/ $TARGET/rules/
grep -rn "~/.claude/" $TARGET/skills/ $TARGET/rules/
grep -rn "../common/" $TARGET/rules/
```

**对于项目级安装**，标记出对 `~/.claude/` 路径的引用：

- `~/.claude/settings.json` — 没问题，设置始终是用户级的
- `~/.claude/skills/` 或 `~/.claude/rules/` — 在项目级安装下可能失效
- 某技能按名称引用另一技能 — 检查被引用的技能是否也已安装

需要检查而非想当然的交叉引用：`*-tdd` 或 `*-testing` 技能通常期望其对应的 `*-patterns` 技能；`continuous-learning-v2` 期望用户级的 `~/.claude/homunculus/` 目录；语言规则会引用其 `common/` 对应文件。请对照实际安装的文件来验证，而不是对照写在这里的列表。

每个问题按"文件、行号、问题所在、建议修复"来报告。

---

## 步骤 9：定制已安装的文件

这一步是评估转化为具体改动的地方。使用 `AskUserQuestion`：

```text
问题: "是否针对本项目定制已安装的文件？"
选项:
  - "定制技能" — "删除不适用的章节，按安装级别修正路径"
  - "定制规则" — "匹配本仓库的覆盖率目标、格式化工具和工作流"
  - "两者都定制" — "对已安装的全部内容做一遍"
  - "跳过" — "保持原样"
```

每一处编辑都要基于步骤 3 收集到的证据 — 项目真实的测试运行器、格式化工具和覆盖率目标 — 而不是让用户重述技术栈。

**关键**：只修改 `$TARGET/` 下的文件。绝不修改位于 `$ECC_ROOT/` 的源仓库。

---

## 步骤 10：记录决策

把评估结果 — 选中项、排除项及各自理由 — 写到项目中一个持久的位置，好让下一次运行是与之做差异对比，而不是从头再来。

如果项目维护着 `ecc-install.json`，让它与实际安装保持一致；之后 `/project-init --config ecc-install.json` 即可复现该安装。

打印一份摘要：安装级别与路径、装了什么、排除了什么及理由、发现并修复的验证问题、以及所做的定制。

---

## 故障排查

### "技能未被 Claude Code 识别"

- 确认技能目录中含有 `SKILL.md` 文件（而不只是零散的 .md 文件）
- 用户级：检查 `~/.claude/skills/<skill-name>/SKILL.md` 是否存在
- 项目级：检查 `.claude/skills/<skill-name>/SKILL.md` 是否存在

### "规则不生效"

- 检查布局与安装方式是否匹配：按语言安装时为 `$TARGET/rules/<language>/`
- 安装规则后重启 Claude Code

### "项目级安装后出现路径引用错误"

- 有些技能假定 `~/.claude/` 路径。步骤 8 会找出这些问题。
- 对于 `continuous-learning-v2`，`~/.claude/homunculus/` 始终是用户级的 — 这是预期行为，不是错误。

### "我期望的某个技能没有被推荐"

评估只推荐有仓库证据支撑的内容。明确提出要求即可安装 — 但"没有被推荐"这件事本身就是一个结论。
