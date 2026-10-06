# 组件系统评审（COMPONENTS_REVIEW.md）——已收档

2026-09 的评审已完结：第四节收敛顺序的九步与 P2-18 的五项零碎全部落地，无遗留。
现行规范见 `COMPONENTS.md`（词汇表、语句模板、宿主事实、`host.json` 的语义都在
那里）；每一步落下的判据与逐提交细节见 `git log`。

| 步 | 内容 | 提交 |
|----|------|------|
| 1 | 词表校验 + guarded/snapshot 参数由声明点名（P0-2 + 审计②） | `fb8541e` refactor(tools): the vocabulary is the host's, and a word it cannot read refuses |
| 2 | `catalog.table()` 记忆化，失效点 = `source_signature()`（P0-1） | `b44f1c5` perf(tools): the table remembers, and the install is resolved once |
| 3 | 句柄合一 `Handle{service, fences, proc}`，键退化成 `(module, root)`（P0-3） | `bf4bb7f` refactor(rendezvous): one handle per daemon, and the fence says whether to ride it |
| 4 | 语句不透明化：宿主只发布事实（P1-5） | `5b7d431`（宿主）+ `0dfdc9b`/`2d70307`（clutch-workspace） |
| 5 | 宿主配置文件化：access→impl、门表、UI 缺省、后端链（审计③⑤ + 边界） | `3ecaa74` refactor(tools): the host's own tables are a document, and the constants are defaults |
| 6 | 消灭第二份实现：技能目录由组件自己发布（审计④） | `01e0977` refactor(tools): the host asks the component for its catalog, and keeps no scan（宿主）+ `d7e40f7` clutch-skills（子模块指针 `0a091c2`） |
| 7 | `run_command` 登记为唯一被声明的引导例外（审计①） | `40a59f9` refactor(tools): the host's own tool is declared, and no component may name it |
| 8 | 信封类型化 + 合并"点名即覆盖" + 提示词片段随声明走（P1-4 + P1-6 + 审计⑥） | `32c3ea7` + `cf995c8` + `3cf0294`（宿主）+ `f985180`/`7a7e506`（clutch-workspace / clutch-memory） |
| 9 | 补测试：参数重命名后的 guard/undo、工具重名、传输 cwd | `3538759` test(tools): the renamed argument, the one name, and the transport a statement rides |
| — | P2-18 的五项零碎（Stop 可达、`ui()` 不再虚构 `mutates`、标量 coercion 等） | `a01e74a` fix(tools): the wiring declares what Stop reaches, and a bad argument is named |

仍开放的边界（与代码同在，非待办）：

- 审计③ 的更深一步：搜索后端的**词汇**仍由宿主持有。第五步把"替组件挑后端"从
  源码搬进了 `host.json`，但"有哪些后端可挑"还没有像技能目录那样由
  clutch-websearch 自己发布。
- 审计⑤ 的残留（已结，连覆盖值一起收了）：`config.skills_dir` 的缺省值曾是
  `component_dir(modules.SKILLS)/"skills"`；第六步删掉的是第二份实现，缺省值后来改成
  `None`，再后来这个字段本身也删了——宿主不再持有任何通往技能库的线，库的位置、库的
  内容、往库里装一个技能都是组件自己的事（`clutch-skills install`，见
  `COMPONENTS.md` 第五节）。

本文原稿（运行逻辑梳理、P0/P1/P2 问题清单、协议知识审计、各步判据全文、复核
命令）随收档提交进入 git 历史：`git log --follow -- COMPONENTS_REVIEW.md`。
代码与测试注释里引用的编号（P0-2、P1-7、审计②…）以历史版本为准。
