---
name: configure-ecc
description: 评估某个仓库真正需要哪些 ECC 技能和规则 — 给出一份基于证据的候选清单，并为每一项排除说明理由 — 然后安装该清单并针对项目进行定制。当用户提到配置、安装或搭建 ECC / everything-claude-code，想决定哪些技能或规则值得加进某个仓库，或想重新评估、精简、修复已有的 ECC 安装时，都使用本技能 — 即使他们只是说"给这个仓库配一下 claude code"而没有点名 ECC。
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

`/project-init` 已经能检测项目技术栈、从清单文件解析出安装计划、执行 dry-run，并在获得批准后才落盘。**不要重复实现其中任何一部分。** 调用它，并把它的输出当作证据使用。

本技能负责 `/project-init` 不做的两件事：

1. **判断** — 技术栈映射是机械的。它无法得出"这个仓库用 Python，但没有 Web 层，所以 `fastapi-patterns` 在这里是噪音"这样的结论。
2. **定制** — 把已安装的文件裁剪到这个项目真正用得上的内容。

## 工作原理

三个阶段，按此顺序进行，因为每一个阶段都让下一个阶段变得负担得起：

1. **按分组淘汰** — 每个主题分组只问一个廉价的问题。一个分组没通过，就把它名下的所有技能一次性移出评估范围。
2. **按证据挑选** — 只在幸存的分组内部，用仓库中的具体信号逐个衡量技能。
3. **用反驳确认** — 在呈现之前，先试着推翻每一条推荐。

只有三关全过的技能才会被推荐。

## 先决条件

此技能必须在激活前对 Claude Code 可访问。有两种引导方式：

1. **通过插件**: `/plugin install ecc@ecc` — 插件会自动加载此技能
2. **手动**: 仅将此技能复制到 `~/.claude/skills/configure-ecc/SKILL.md`，然后通过说 "configure ecc" 激活

---

## 步骤 0：定位 ECC 源

优先使用用户已有的本地检出。克隆远程仓库是兜底手段，绝不是默认做法 — 在 fork 上克隆上游会静默地装上用户并未在运行的代码，而 `commands/project-init.md` 已经明令禁止这样做。

使用本仓库已经提供的解析器，而不是临时另猜一套：

逐个检查每个候选项，而不是认定第一个非空的就是答案 — 下面每一个来源都可能交回一个并非 ECC 目录树的路径：

```bash
is_ecc() { [ -f "$1/scripts/install-plan.js" ] && [ -f "$1/manifests/install-modules.json" ]; }

ECC_ROOT=""
for cand in \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "$(node -e 'try{console.log(require(require("os").homedir()+"/.claude/scripts/lib/resolve-ecc-root").resolveEccRoot())}catch(e){}' 2>/dev/null)" \
  "$(git rev-parse --show-toplevel 2>/dev/null)"; do
  if [ -n "$cand" ] && is_ecc "$cand"; then ECC_ROOT="$cand"; break; fi
done

[ -n "$ECC_ROOT" ] || { echo "No ECC checkout found — set CLAUDE_PLUGIN_ROOT or pass a path"; exit 1; }
```

中间那两步的失败都长得像成功。`resolveEccRoot()` 在找不到任何安装时会返回 `~/.claude` — 非空，却不是一棵 ECC 目录树 — 所以"谁先非空谁胜出"的链条会停在这里，永远走不到 git 兜底那一步。而 `git rev-parse` 在*任何* git 仓库里都会成功，于是它会心安理得地返回用户自己的项目。每个候选项都只是一次猜测；把猜测变成答案的是 `is_ecc`，这正是它要对所有候选项逐一执行、而不是最后只跑一次的原因。

如果所有途径都失败，就如实说明，并向用户索要路径。只有在获得明确同意后才克隆
`https://github.com/affaan-m/everything-claude-code.git`，并在安装完成后 `rm -rf` 掉这份克隆。

---

## 步骤 1：从清单文件构建候选集

```bash
node "$ECC_ROOT/scripts/install-plan.js" --list-components --family skill --json
```

如果这条命令以非零状态退出或没有任何输出，就停下来报告错误。带着一个空候选集继续，比直接失败更糟：因为"查询失败"和"仓库确实什么都不需要"这两种情况，最终都呈现为 "Recommended (0)" — 用户没有任何办法分辨究竟发生了哪一种。

永远不要在本文件中硬编码技能列表。任何写在这里的列表，在新增一个技能的那一刻就已过期；而硬编码列表会悄悄缩小候选集 — 只能看到一小部分候选项的评估，不算评估。

---

## 步骤 2：按分组淘汰

逐个判断每一个候选项既负担不起也没有必要。目录中的大部分内容可以在一轮里排除掉。

读取 `$ECC_ROOT/manifests/install-modules.json`。`id` **不以** `skill-` 开头的模块就是主题分组；每个模块的 `paths` 通配符指明了它所拥有的技能。对每个分组问一个廉价的问题 — "这个仓库是否涉及这个领域？" — 用文件清单、包管理清单和 CI 配置来回答。

如果这个文件读不出来或解析不了，就停下来报告，和步骤 1 完全一样。一份读不出来的清单文件会产出零个分组，于是每个候选项都默认幸存，报告最终显示什么都没被淘汰 — 而这与"如实得出每个分组都适用"的结论无从分辨。

一个否定回答就移除该分组下的全部技能。评估的成本正是在这里被真正控制住的。

要果断地淘汰，因为两种代价并不对称：错误排除一个分组，代价是用户多说一句话；而错误纳入一个分组，代价是每次会话都要消耗上下文，且没有尽头。

两条对账规则：

- 有少数技能不属于任何主题分组。把幸存集合与步骤 1 得到的完整列表对账，这样分组扫描就不会成为唯一的入口。
- 记录哪些分组被淘汰、依据是什么。这份记录要写进报告 — 它构成了"明确排除"一节的主体。

有些分组虽然幸存，但仓库对它们根本无从作答 — 业务、内容、行业领域这类 — 它们既不淘汰也不评估，而是各自作为一个问题留到步骤 6。

---

## 步骤 3：按证据挑选

仅针对幸存分组内部的技能。

运行 `/project-init --dry-run`，保留它检测到的技术栈证据和解析出的计划。如果它失败或什么都没返回，就如实说明，并仅凭仓库中的证据继续 — 不要让一次工具失败冒充成"这个仓库没有技术栈信号"，因为从这里看，空结果正是那副样子。交叉参考 `$ECC_ROOT/config/project-stack-mappings.json`，它把项目指示文件映射到 ECC 的技能、规则、钩子和命令。它只覆盖了整个目录中的一小部分，因此命中就当作捷径，未命中则既不算支持也不算反对。

然后通过阅读仓库，越过映射所能表达的范围：

- 被映射到的框架中，哪些是真正在用的，哪些只是作为传递依赖存在？
- 仓库是否具备某个技能所假定的那一层 — Web 层、数据库层、CI 流水线、UI？
- 已有的 `CLAUDE.md`、`.claude/rules/` 或团队既有规范，是否已经覆盖了该技能要补充的内容？
- 测试和构建脚本说明了这个团队实际是怎么工作的？

每一条推荐都必须带上一个可证伪的主张 — 一个别人能重新核对的文件与行号，而不是印象。"看起来像个 React 项目"不是证据；"`package.json:14` 依赖 `react@19`"才是。这么要求不是为了形式：没人能核对的主张就是没人能纠正的主张，而这份报告本就是拿来被反驳的。缺少这种主张的推荐不是一条弱推荐，它就是一条排除。

不要询问用户的技术栈是什么。仓库本身就能回答，而发问本身就说明评估被跳过了。

为每个幸存候选项补上两个信号 — 清单文件里有、但 component 记录里没有的那两个：

**来源** — 从 `$ECC_ROOT/skills/<id>/SKILL.md` 读取 `metadata.origin`。实际出现的取值包括 `ECC`（第一方）、`community`，以及厂商或个人贡献者。有相当多技能根本没有声明来源：这些一律报告为 `unknown`。要抵住把缺失来源默认成 `ECC` 的冲动 — 文件位于 ECC 仓库内部，并不能说明它是谁写的，而第一方技能与单一厂商的领域技能，绝不能作为等价的推荐项呈现给用户。

**成熟度** — 从 `$ECC_ROOT/manifests/install-modules.json` 中拥有该技能的模块读取 `stability`。取值为 `stable` 和 `beta`。推荐时要标出 `beta`。

**遗留状态 — 已知局限。** 清单文件中不存在任何 `deprecated` 字段，也没有技能的生命周期策略。唯一可用的信号是描述中的自由文本，因此匹配 `legacy`、`superseded` 和 `prefer <other-skill>`，并把结果视为*不完整*。在报告中如实说明，而不要让人以为这项检查是穷尽的。目前它唯一能捕捉到的案例是 `continuous-learning`，已被 `continuous-learning-v2` 取代。

---

## 步骤 4：评估规则

规则单独评估，因为它们背后的数据更稀薄。在运行时枚举 `$ECC_ROOT/rules/*/`，而不是在这里罗列语言名。

规则没有清单 component，没有分组，没有 `origin`，也没有 `stability` — 整棵目录树作为一个模块安装。在报告中把这几列留空，而不要去推断并不存在的取值。

规则真正拥有的，是本技能中最容易得到的证据：目录名本身就是信号。`rules/python/` 由一个 `pyproject.toml` 来支撑，而不是靠主观判断。套用与步骤 3 相同的标准 — 指明那个指示文件 — 其余的自然成立。

语言规则是对通用规则集的扩展。如果评估选中了某个语言却没有选 `common`，要说明这一点并建议补上。

---

## 步骤 5：用反驳确认

在呈现任何内容之前，先试着推翻它。把每条推荐的主张**单独**拿出来，剥离产生它的那套推理，去找它错在哪里：

- 那个指示文件真的存在吗，真的在那个路径上，真的写着所声称的内容吗？
- 那个依赖是真的在用，还是只是声明了一下？
- 仓库是否已经解决了这个问题，从而使该技能是冗余的、而非有用的？

凡是过不了这一关的都要丢掉。把主张与其推理分离，正是这一步的全部意义：模型重读自己的论证时往往会觉得很有说服力，因此一个去寻找佐证的验证环节只会增加信心，不会增加正确性。去寻找反驳，才让这道检查值得跑。

把每一条推荐都当作受预算约束的，而不是"把所有可能沾边的都选上"。"这个项目是 Python"足以支撑 `python-patterns`，但不足以支撑 Python 生态里的每一个技能。

与已经在做这类度量的技能组合使用，而不是重新发明它们：

- `context-budget` — 审计技能、规则、agent 和 MCP server 的上下文消耗
- `skill-stocktake` — 审计已安装技能和命令的质量

如果仓库已有 ECC 安装，与之做差异对比：对于支撑证据已经消失的技能，要推荐移除，而不只是推荐新增。

---

## 步骤 6：报告评估结果

在安装任何东西**之前**先呈现评估结果，使用如下结构：

```text
## ECC Assessment — <repo>

### Detected evidence
- <signal at file:line> -> <what it implies>

### Recommended (N)
| Skill | Origin | Maturity | Evidence (file:line) | Why |

### Deliberately excluded (M)
| Skill / bundle | Why not |

### The repository cannot answer these
- <bundle> — <the one question to ask the user>

### Not assessed
- <anything the available data could not judge, including the legacy-detection gap>
```

排除表不是凑数。它是"确实做过决定"的记录，也是让下一次运行变成差异对比、而不是重新猜一遍的依据。

只就第三节里的那些分组向用户提问 — 每个分组一个问题，而不是每个技能一个问题。然后用 `AskUserQuestion` 确认这份清单。绝不要罗列完整候选集：那放不下，而且呈现它本身就违背了评估的意义。

---

## 步骤 7：选择安装级别

使用 `AskUserQuestion`：

```text
Question: "Where should the selected components be installed?"
Options:
  - "User-level (~/.claude/)" — "Applies to all your Claude Code projects"
  - "Project-level (.claude/)" — "Applies only to the current project"
  - "Both" — "Common/shared items user-level, project-specific items project-level"
```

设置目标目录：

- 用户级: `TARGET=~/.claude`
- 项目级: `TARGET=.claude`（相对于当前项目根目录）
- 两者: 不存在合并的目标目录。对每个级别各跑一遍步骤 8 和步骤 9，每次都设置好 `TARGET`，并有意识地拆分清单 — 共享的技能装到用户级，项目专属的装到项目级。

在下面的任何内容运行之前，`TARGET` 必须已经有值。未设置的 `TARGET` 不会大声报错：`mkdir -p $TARGET/skills` 会悄无声息地变成在文件系统根目录执行 `mkdir -p /skills`，之后每一次 `cp` 都会跟着跑到那里去。

```bash
mkdir -p "$TARGET/skills" "$TARGET/rules"
```

---

## 步骤 8：安装清单

对每个已批准的技能，从正确的源根目录复制整个技能目录。在"两者"安装下，只复制步骤 7 分配给当前这个 `TARGET` 的那个子集 — 把完整清单跑两遍，会把每一个共享技能都装进两个位置，而步骤 9 抓不到这一点，因为它检查的是已批准的条目在不在，而不是有没有多出来的条目。

```bash
# Core skills live under .agents/skills/
cp -R "$ECC_ROOT/.agents/skills/<skill-name>" "$TARGET/skills/"

# Everything else lives under skills/
cp -R "$ECC_ROOT/skills/<skill-name>" "$TARGET/skills/"
```

在遍历通配得到的源目录时，绝不要把带尾斜杠的源路径直接传给 `cp`。显式使用目录名作为目标名：

```bash
cp -R "${src%/}" "$TARGET/skills/$(basename "${src%/}")"
```

检查每一次复制的退出状态，一旦失败立即上报。一个静默复制失败的技能，比一个从未被选中的技能更糟，因为报告接下来会声称它已经装好了。

复制整个目录，而不只是 `SKILL.md` — 有几个技能在其旁边附带 `config.json`、钩子或脚本（`continuous-learning`、`continuous-learning-v2`）。

安装评估选中的规则目录，保留按语言划分的布局：

```bash
cp -r "$ECC_ROOT/rules/common" "$TARGET/rules/common"
cp -r "$ECC_ROOT/rules/<language>" "$TARGET/rules/<language>"
```

---

## 步骤 9：验证安装

先把磁盘上的实际内容与**本次** `TARGET` 所批准的内容对账。在"两者"安装下，那指的是步骤 7 分配给当前正在验证的这一级别的那个子集，而不是步骤 6 的整份清单 — 拿完整清单去做差异对比，会在每一轮都把另一个级别的技能报成缺失，真正的故障就会淹没在这些噪音里。

```bash
ls -la "$TARGET/skills/" "$TARGET/rules/"
```

要清点并做差异对比 — 不要只是扫一眼。每一个已批准的条目都必须在场。这个先后顺序很重要，因为在下面这些 grep 检查之下，一个空目录读起来与"一切正常"毫无区别：`grep` 什么都没找到，和 `grep` 根本没有东西可搜，产生的输出是一样的。安装不完整必须按安装失败来报告，而不是报成"没有发现问题"。

```bash
grep -rn "~/.claude/" "$TARGET/skills/" "$TARGET/rules/"
grep -rn "../common/" "$TARGET/rules/"
```

**对于项目级安装**，标记出对 `~/.claude/` 路径的引用：

- `~/.claude/settings.json` — 没问题，设置始终是用户级的
- `~/.claude/skills/` 或 `~/.claude/rules/` — 在项目级安装下可能失效
- 某技能按名称引用另一技能 — 检查被引用的技能是否也已安装

交叉引用要推导出来，而不是想当然：在已安装的文件里 grep 步骤 1 中其他候选项的名字，凡是命中却没有安装的都要报告。在"两者"安装下，在断定某个引用失效之前要把两个目标都检查一遍 — 项目级的技能完全可能合理地依赖一个装在用户级的技能。`*-tdd` 或 `*-testing` 技能通常期望其对应的 `*-patterns` 技能，`continuous-learning-v2` 期望用户级的 `~/.claude/homunculus/` 目录 — 但这些要靠实地查找来发现，因为写在这里的依赖列表，会像硬编码的技能列表一样过期。

每个问题按"文件、行号、问题所在、建议修复"来报告。

---

## 步骤 10：定制已安装的文件

这一步是评估转化为具体改动的地方。使用 `AskUserQuestion`：

```text
Question: "Tailor the installed files to this project?"
Options:
  - "Tailor skills" — "Drop sections that do not apply, fix paths for this install level"
  - "Tailor rules" — "Match coverage targets, formatters, and workflow to this repo"
  - "Tailor both" — "Full pass over everything installed"
  - "Skip" — "Keep everything as-is"
```

每一处编辑都要基于步骤 3 收集到的证据 — 项目真实的测试运行器、格式化工具和覆盖率目标 — 而不是让用户重述技术栈。

**关键**：只修改 `$TARGET/` 下的文件。绝不修改位于 `$ECC_ROOT/` 的源仓库。

---

## 步骤 11：记录决策

把评估结果 — 选中项、排除项及各自理由 — 写到项目中一个持久的位置，好让下一次运行是与之做差异对比，而不是从头再来。要记录**跑过哪些检查**，而不只是结论：打开了哪些文件、搜索了什么。正是这些内容能把下一次运行变成一次差异对比（"上次没有 React，这次有了"），而不是重新猜一遍。

如果项目维护着 `ecc-install.json`，让它与实际安装保持一致；之后 `/project-init --config ecc-install.json` 即可复现该安装。该格式只容纳一个 `target`，因此"两者"安装塞不进一个文件 — 要么每个级别各写一条记录，要么在记录里写明它覆盖的是哪一个级别。不要让它悄无声息地把半个安装描述得好像那就是全部。

打印一份摘要：安装级别与路径、装了什么、排除了什么及理由、发现了哪些验证问题以及实际对它们做了什么、以及所做的定制。步骤 9 只负责报告问题；本技能中没有任何环节会自行修复它们，因此除非确实做了修复，否则不要写"已修复"。

---

## 示例

**一个没有前端的 Django API。** `pyproject.toml` 和 `manage.py` 都在，没有 `package.json`。前端、JVM、Swift 和移动端这几个分组在步骤 2 就被淘汰，一个技能文件都不用读。`django-patterns` 和 `django-tdd` 依据 `manage.py:1` 和一个 `pytest.ini` 被推荐；`django-security` 被推荐，是因为 `settings.py` 从环境变量暴露了 `DEBUG`。`frontend-patterns` 被排除，报告会明说这一点，而不是保持沉默。`rules/python/` 和 `rules/common/` 由 `pyproject.toml` 推得。

**一个已经配置过的仓库。** 步骤 2 发现存活的分组与上次相同，只有一个例外：`.github/workflows/` 目录没了。报告以一条移除建议开头，而不是一份安装清单。

**一次失败的查询。** `install-plan.js` 以非零状态退出，因为 `ECC_ROOT` 指向了一棵没有清单文件的目录树。步骤 1 就此停下并报告错误，而不会报出 "Recommended (0)"。

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

- 有些技能假定 `~/.claude/` 路径。步骤 9 会找出这些问题。
- 对于 `continuous-learning-v2`，`~/.claude/homunculus/` 始终是用户级的 — 这是预期行为，不是错误。

### 步骤 0 报 "No ECC checkout found"

没有任何候选项通过 `is_ecc` — 通常是因为 ECC 没有作为插件安装，而你当前所在的那个仓库本身也不是 ECC。设置 `CLAUDE_PLUGIN_ROOT`，或者把你的 ECC 克隆路径传进去。

### "我期望的某个技能没有被推荐"

先看排除表：如果它所属的分组在步骤 2 就被淘汰了，那么这个技能从未被单独评估过，该去反驳的是分组层面的证据。明确提出要求即可安装 — 但"没有被推荐"这件事本身就是一个结论。
