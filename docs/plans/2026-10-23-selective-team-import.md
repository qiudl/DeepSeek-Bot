# 选择性迁入现有 DS Bot 团队（REQ-20261023-0001）

本设计服务于 Slark 同账号跨设备团队同步：目标设备的现有团队是唯一执行与写入权威，来源设备的主 Bot 及其聊天和记忆须在校验后迁入，已有 Bot 保留。随后新增 Bot、群聊、聊天和记忆按同一权威规则持续同步。此 fork 分支独立开发，不向上游提交。

## 已知边界

- `app/src/import.mjs` 仅供空团队首次导入：它拒绝非空目标，并复制整份团队、Session、附件和部分密钥配置，不适合合并现有团队。
- 一个 Bot 的 `id` 是第一段 Session ID；`sessionId` 指当前聊天段；`segments[]` 指旧段。群聊另有成员 Session 和旧段。只合并 `state.json` 会丢聊天与模型上下文。
- DSH `sessionController.create` 只创建空白 Session；`ctx.agents.create({ seed })` 可经正式插件 API 建立带旧历史的持久 Agent。隔离 mock 试验已验证旧用户/助手消息进入下一次模型请求并在重启后恢复。真实历史和 DS Bot 映射尚未通过验证。
- DSH V4 校验要求受保护的首个 `system/message` surface 节点。当前两端活动段符合；没有可见聊天的旧段应当只作为历史段保留。
- 旧 Session header 中的 `cwd`、原模型选择、密钥和插件授权不能直接转移到目标设备。目标 Agent 应使用目标 Workspace 的绝对目录、目标机可用模型和目标 Agent preset。
- 隔离 mock 的 10 个团队 Session 共含 240 个 Zstandard 帧；只解压首帧会误以为 Session 没有聊天。逐帧只读检查发现结构化引用位于投递回执的 `data.sessionId`、用户消息及收件箱插入记录的 `senderSessionId`/`roomId`；绝对 `cwd` 位于 Session header。事件映射器只改这些结构化 ID，保留正文，未知结构化 Session 引用拒绝。此证据来自 mock，不能代替真实历史验证。

## 导入事务

1. **只读盘点**：固定源 Profile 与目标团队的状态修订、文件摘要、Bot/群聊关系、Session 格式与附件可用性。未知、混合、损坏格式拒绝进入写阶段。
2. **预览与映射**：为源 Bot、群聊和每段 Session 分配新的目标 ID，保留来源 ID 到目标 ID 的私有映射。主 Bot 改为迁入的身份；原有目标 Bot 不删除。重复请求使用同一映射与摘要。

映射规划器 `ds-bot/src/host/team-import-plan.js` 只读两份团队状态，覆盖群聊自身 Session、成员当前段和旧段，并可接收目标 Profile 的全部已占用 Session ID。目标的普通 DSH Agent Session 计入占用，来源的普通 DSH Agent 不作为 DS Bot 团队聊天迁入；若一个 Session 被不同聊天引用，或新目标 ID 恰好是任一来源 Session ID，导入前直接拒绝。规划结果不是迁移完成回执，也不创建 Session。
规划同时记录两端状态的规范化摘要。`team-import-stage.js` 在修订号与摘要未变化时，生成未激活的 Bot/群聊候选状态：目标原有 Bot 和群聊保留，来源主 Bot 排在首位；原目标主 Bot 仍可查看，但不再占据共享主 Bot 身份。来源的模型、工作目录、权限、能力绑定和运行中状态不进入候选，模型只能由目标机器显式指定。聊天段与群成员 Session 全部按映射改 ID，群日志的 Bot 引用也随之改写；重名或断裂引用直接拒绝。此候选状态**不含 Session 正文、附件、记忆和团队交换日志**，不能单独落盘或宣称迁入完成。
3. **隔离生成**：对每段历史做格式与敏感字段审查，按 DSH 公共 API 创建目标 Session。活动段使用 `ctx.agents.create({ seed, meta, agentOptions, setup })`，通过 `ctx.agentPresets.mount()` 绑定目标 preset，随后关联 Workspace、标题、模型与权限。旧段不能误当成活动 Agent。

`team-import-events.js` 对解码后的事件序列做只读校验：seq 从零连续、活动段首个 surface append 为受保护的 `system/message`，并把已知结构化 Session 引用改为规划目标 ID。Session header 与来源 `cwd` 不参与事件 seed，聊天正文中引用的文字保持原样。它不负责解码磁盘文件或创建 Agent；即使全部事件能映射，也必须经 DSH 公共 API 持久化与下一回合验证。
4. **校验与激活**：核对消息顺序、上下文、附件引用、群聊成员、记忆版本及目标原有数据指纹。只有全部通过，才原子写入团队映射和主 Bot 选择；失败保留源与原团队入口，可安全重试。
5. **持续运行**：目标设备单独执行回合和计划任务。远端只通过受信设备的有界读、写及回执契约访问；不能透传任意 `/api/bot` 端点、Cookie、工作目录或密钥。离线端只看加密只读副本。

`channel.js` 当前的内部 `READS` 集合不是远程安全边界：其中的 `browser-result`、`diagnostics-clear`、`update-install`、`dsh-update-install` 等具有副作用；`state` 返回值还含密钥名称、能力和模型目录。远程适配必须另建精确的只读投影和写命令枚举，并逐字段过滤响应，不能复用这个集合或直接透传 `state`。

## 待验证门槛

- 真实发行格式的完整旧历史是否能脱敏迁入并供下一次模型回合使用，尤其是工具结果、系统提示、附件和历史段。
- Agent preset、Workspace attach、模型选择、权限、标题和重启后的 Bot 身份是否与普通创建的 Bot 等价。
- 中断、重复请求、目标已有同名 Bot、附件缺失、模型不可用及源文件变化时，是否始终保留原团队且不重复执行。
- 群聊日志、成员 Session、Bot/群/团队记忆的顺序、来源和版本是否可恢复。

这些门槛通过前，不对真实 Profile 写入，也不把首次搬运视为持续同步交付。

## 当前验证矩阵

2026-10-23：fork `dev` 声明的 DSH `0.2.1-rc.2` 下，完整单元测试 870 通过、2 跳过、0 失败；客户端生成物检查与 lint 通过。Slark 当前固定的 DSH `0.2.1-alpha.2` 下，隔离 mock Web 烟测 52 步全部通过；完整单测有两个测试文件因该旧版本缺少 `dsh-session-reference` 和 `dsh-client-modules` 模块而不能通过。导入器尚未实现，以上结果不能当作迁移验收。

候选状态代码增加后，声明版 DSH 的完整单测为 875 通过、2 跳过、0 失败，lint 0 错误，客户端生成物检查通过；固定版 DSH 的隔离 mock Web 烟测 52 步全部通过。对烟测产出的实际 DS Bot 状态做只读演练，来源 3 个 Bot、1 个群聊被映射成目标 4 个 Bot、1 个群聊，目标原 Bot 保留。演练没有写入任何 Profile，也没有证明原生 Session 或记忆可迁入。

事件映射器增加后，对同一隔离 mock 团队 10 个 Session（4 个活动段）的 658 条已解码事件做只读预检与映射，数量一致且全部通过；这仍未执行 DSH `ctx.agents.create({ seed })`，不构成模型上下文连续性的验收。

随后在另一个**隔离 Profile** 中，以正式 `runProfile` 和 `ctx.agents.create({ seed, meta, setup })` 导入一段来自上述 mock 团队的 173 条活动历史事件；setup 按 DSH 契约挂载 `standard` preset 并返回 `void`，目标 Workspace 与标题由目标机创建，`ctx.sessions.flush(session)` 后关闭并重新启动。重启前后均恢复 47 条聊天消息；选择目标 mock 模型后，新回合正确回答旧聊天中的独有事实。两端隔离 Web 与 mock 进程均已停止。此试验仍未导入所有 Bot/群聊/记忆，也未对 Boston 真实历史运行，更不表示长期同步已可用。

活动段阶段器 `team-import-agent.js` 在创建 DSH Agent 前，先要求 `team-import-journal.js` 以排他写入方式将源/目标 ID、状态摘要和事件摘要持久化；相同目标 ID 的重试一律拒绝。创建后核验 seed 前缀，关联目标 Workspace、标题和显式目标模型，flush 成功才把日志改为 `staged`。中途失败标为 `needs-review`；进程直接终止时保留 `pending`，均禁止自动重建，待人工或后续恢复器核对已持久化的 Session。日志不含聊天正文，也不修改团队状态。此模块尚未接入 DS Bot Host 的正式导入命令，尚未实现历史空段、附件、记忆、原子激活及长期同步。

在 m5max 新建的隔离 `req6148agent` Profile 上，使用阶段器和磁盘日志重做正式 DSH seed 探针：173 条 mock 历史事件、重启前后各 47 条消息，后续 mock 模型回合仍能引用旧事实，日志最终状态 `staged`。声明版 DSH `0.2.1-rc.2` 完整单测为 883 通过、2 跳过、0 失败；lint 0 错误，生成物检查通过。Slark 固定版 DSH `0.2.1-alpha.2` 的另一隔离 mock Web 烟测 52 步全部通过。隔离 Web 与 mock 端口已停止。结果只证明一个活动聊天段的阶段器路径，不能代替完整团队迁入验收。

长期记忆另有只读清单 `team-import-memory.js`：仅列出当前 Bot、群聊和团队作用域里的 `MEMORY.md` 与主题 Markdown，映射目标作用域并计算文件大小和 SHA-256；拒绝符号链接、孤儿作用域和未知文件。`snapshots/` 是 Session 冻结提示词，`reviewed.json` 是复盘游标，均不得冒充长期记忆或原样复制。m5max 隔离 mock 来源当前活动作用域没有长期记忆文件，只有已删除群聊的归档文件；清单正确返回 0。归档、复盘游标、记忆变更 journal 和目标已有团队记忆的合并仍须另行设计与验证，清单不能作为记忆迁入完成凭证。

增加目标记忆作用域碰撞拒绝后，声明版 DSH 完整单测为 886 通过、2 跳过、0 失败；lint 0 错误、生成物检查通过。固定版 DSH 的新隔离 mock Web 烟测 52 步全部通过，两个测试端口已停止。

`team-import-memory-stage.js` 先复核团队状态摘要和长期记忆文件清单，再把 Bot、群聊、团队记忆的原始字节写入目标 Host 私有、权限为 `0700` 的未激活暂存目录。清单记录源与目标团队摘要；文件写入前后都核对大小和 SHA-256。暂存目录以排他创建，已有 `pending` 或 `staged` 目录一律拒绝重试，避免中断后覆盖部分文件。模块不修改活动团队记忆；尤其不能把暂存的 `team/MEMORY.md` 直接覆盖 m5max 已有团队记忆。归档、journal 和复盘游标仍未迁入，正式激活和故障恢复器仍待实现。

暂存器还按真实路径拒绝将暂存放进来源或目标正式记忆目录，并拒绝符号链接形式的暂存上级目录。最终代码在声明版 DSH 下完整单测 891 通过、2 跳过、0 失败，lint 0 错误，生成物检查通过；固定版 DSH 的隔离 mock Web 烟测 52 步全部通过，Web 与 mock 已停止。这些验证没有写入真实 Profile。
