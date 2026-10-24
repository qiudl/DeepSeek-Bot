# 选择性迁入现有 DS Bot 团队（REQ-20261023-0001）

本设计服务于 Slark 同账号跨设备团队同步：目标设备的现有团队是唯一执行与写入权威，来源设备的主 Bot 及其聊天和记忆须在校验后迁入，已有 Bot 保留。随后新增 Bot、群聊、聊天和记忆按同一权威规则持续同步。此 fork 分支独立开发，不向上游提交。

## 已知边界

- `app/src/import.mjs` 仅供空团队首次导入：它拒绝非空目标，并复制整份团队、Session、附件和部分密钥配置，不适合合并现有团队。
- 一个 Bot 的 `id` 是第一段 Session ID；`sessionId` 指当前聊天段；`segments[]` 指旧段。群聊另有成员 Session 和旧段。只合并 `state.json` 会丢聊天与模型上下文。
- DSH `sessionController.create` 只创建空白 Session；`ctx.agents.create({ seed })` 可经正式插件 API 建立带旧历史的持久 Agent。隔离 mock 试验已验证旧用户/助手消息进入下一次模型请求并在重启后恢复。真实历史和 DS Bot 映射尚未通过验证。
- DSH V4 校验要求受保护的首个 `system/message` surface 节点。当前两端活动段符合；没有可见聊天的旧段应当只作为历史段保留。
- DSH `SessionStore` 明确只管理内存，直接 `ctx.sessions.create({ seed })` 不会自动附加持久日志写句柄；Agent 工厂的 `ctx.agents.create({ seed })` 才会在发布前写入 seed。历史段不能用裸 Session 创建冒充持久迁入。m5max 隔离 mock 的有 surface 旧段和无 surface 前导事件均已通过 Agent 工厂的重启恢复探针；正式 Host 仍须禁止历史段接收新回合。
- 旧 Session header 中的 `cwd`、原模型选择、密钥和插件授权不能直接转移到目标设备。目标 Agent 应使用目标 Workspace 的绝对目录、目标机可用模型和目标 Agent preset。
- 隔离 mock 的 10 个团队 Session 共含 240 个 Zstandard 帧；只解压首帧会误以为 Session 没有聊天。逐帧只读检查发现结构化引用位于投递回执的 `data.sessionId`、用户消息及收件箱插入记录的 `senderSessionId`/`roomId`；绝对 `cwd` 位于 Session header。事件映射器只改这些结构化 ID，保留正文，未知结构化 Session 引用拒绝。此证据来自 mock，不能代替真实历史验证。

## 导入事务

1. **只读盘点**：固定源 Profile 与目标团队的状态修订、文件摘要、Bot/群聊关系、Session 格式与附件可用性。未知、混合、损坏格式拒绝进入写阶段。
2. **预览与映射**：为源 Bot、群聊和每段 Session 分配新的目标 ID，保留来源 ID 到目标 ID 的私有映射。主 Bot 改为迁入的身份；原有目标 Bot 不删除。重复请求使用同一映射与摘要。

映射规划器 `ds-bot/src/host/team-import-plan.js` 只读两份团队状态，覆盖群聊自身 Session、成员当前段和旧段，并可接收目标 Profile 的全部已占用 Session ID。目标的普通 DSH Agent Session 计入占用，来源的普通 DSH Agent 不作为 DS Bot 团队聊天迁入；若一个 Session 被不同聊天引用，或新目标 ID 恰好是任一来源 Session ID，导入前直接拒绝。规划结果不是迁移完成回执，也不创建 Session。
规划同时记录两端状态的规范化摘要。`team-import-stage.js` 在修订号与摘要未变化时，生成未激活的 Bot/群聊候选状态：目标原有 Bot 和群聊保留，来源主 Bot 排在首位；原目标主 Bot 仍可查看，但不再占据共享主 Bot 身份。来源的模型、工作目录、权限、能力绑定和运行中状态不进入候选，模型只能由目标机器显式指定。聊天段与群成员 Session 全部按映射改 ID，群日志的 Bot 引用也随之改写；重名或断裂引用直接拒绝。此候选状态**不含 Session 正文、附件、记忆和团队交换日志**，不能单独落盘或宣称迁入完成。
3. **隔离生成**：对每段历史做格式与敏感字段审查，按 DSH 公共 API 创建目标 Session。活动段使用 `ctx.agents.create({ seed, meta, agentOptions, setup })`，通过 `ctx.agentPresets.mount()` 绑定目标 preset，随后关联 Workspace、标题、模型与权限。旧段不能误当成活动 Agent。

`team-import-events.js` 对解码后的事件序列做只读校验：seq 从零连续、活动段首个 surface append 为受保护的 `system/message`，并把已知结构化 Session 引用改为规划目标 ID。Session header 与来源 `cwd` 不参与事件 seed，聊天正文中引用的文字保持原样。它不负责解码磁盘文件或创建 Agent；即使全部事件能映射，也必须经 DSH 公共 API 持久化与下一回合验证。

历史段复用 `team-import-agent.js` 的 `historyOnly` 模式：事件仍经映射校验，但允许没有聊天 surface 的旧前缀；仍使用 DSH Agent 工厂保证 seed 被持久化。此模式不绑定显式模型，也不把 Session attach 到目标 Workspace，并在私有日志中标为 `history`。它尚未接入正式导入入口；“未 attach”只表示不会进入该 Workspace 的列表，不能代替未来 Host 对历史段禁止新回合的授权检查。
4. **校验与激活**：核对消息顺序、上下文、附件引用、群聊成员、记忆版本及目标原有数据指纹。只有全部通过，才原子写入团队映射和主 Bot 选择；失败保留源与原团队入口，可安全重试。
5. **持续运行**：目标设备单独执行回合和计划任务。远端只通过受信设备的有界读、写及回执契约访问；不能透传任意 `/api/bot` 端点、Cookie、工作目录或密钥。离线端只看加密只读副本。

`channel.js` 当前的内部 `READS` 集合不是远程安全边界：其中的 `browser-result`、`diagnostics-clear`、`update-install`、`dsh-update-install` 等具有副作用；`state` 返回值还含密钥名称、能力和模型目录。远程适配必须另建精确的只读投影和写命令枚举，并逐字段过滤响应，不能复用这个集合或直接透传 `state`。

`team-remote-read.js` 现通过 Profile-local `dsBotSlarkRemoteRead` 服务提供 `team` 目录分页：Bot 的逻辑 ID、名称、角色和主 Bot 标记，以及群聊逻辑 ID、名称和成员。它要求本 Host 真正持有团队独占写锁，拒绝导入标记、只读副本和失锁状态；游标绑定团队修订号并限制返回字节。模型、工作目录、指令、密钥、原生 Session ID 与群日志均不在响应中。用户 fork 的 DSH 分支已有 Account 绑定的 Unix `profile.bot_team_read`，Slark 隔离源码已有受信设备 E2EE 的 `bot/team` 转发；正式 Slark 安装包尚未固定该 DSH 分支，也没有 Bot 页面消费入口。

同一服务新增 `memory` 的 Profile-local 投影：只接受 `team`、现有 `bot:<id>` 或 `room:<id>` 的逻辑范围，不接受任意路径/Profile 选择器。只读扫描该范围的 `MEMORY.md` 和小写主题 Markdown，拒绝符号链接、未知文件和超限文件；每页至多 32 KiB 原始字节，以 base64 返回文件名、字节偏移、总字节数和 SHA-256。游标绑定整个范围所有文件的摘要；页间文件变化必须从头重读。空范围与不存在的记忆目录返回空页，不把快照或 `reviewed.json` 冒充事实记忆。DSH 用户 fork 已有 Account 绑定的 Unix `profile.bot_memory_read`，Slark 隔离源码已有受信设备 E2EE 的 `bot/memory` 转发；正式安装包尚未固定这些版本，DS Bot 页面未消费该入口。聊天读取、发送回执、Boston 加密副本也未实现。

聊天投影的来源不能简单使用团队状态：`groups.js` 的 `ROOM_LOG_MAX=60`，`room.log` 只保留最近 60 条群消息；长消息的 `group-lines/` 文件也随旧条目滚出而删除。Bot 私聊由多个持久化 DSH Session 段组成，群成员又有各自的 Session 段。后续只读投影须按团队逻辑 ID 验证 Session 所有权，通过 DSH 公共持久化接口读取、去重并保留可证明的顺序；单靠 `room.log` 会永久漏掉旧群消息。需要先验证旧群 Session 能恢复哪些用户/Bot 发言与系统通知，再确定对不可恢复旧行的明确状态；对新增群消息应建立持久的完整历史来源和中断恢复规则，才能宣称长期聊天同步完整。

当前迁入预核验增加一个拒绝闸门：从未写入消息、尚无 `seq`/`log` 的新群聊视为空历史；其余来源群聊的 `seq` 必须从 1 到当前值与 `room.log` 逐条连续，且任何条目都不能带表示正文截断的 `length`。超过 60 条已滚出的旧行、缺号或长消息均不能用状态缓存证明“聊天完整迁入”；预核验在团队激活前拒绝。这个闸门不恢复旧数据，也不代替后续的 DSH Session 取证或新群消息持久日志。

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

m5max 隔离 `req6148agent` Profile 后续又验证历史模式：一个带 `system/message` 的旧段有 122 条源事件、30 条聊天消息，重启后原始前缀和消息数不变；另从 mock 活动段截取了 9 条无 surface 的前导事件，经两次重启原始前缀仍一致、无聊天消息，DSH 首次恢复时补写生命周期结束事件，下一次重启数量稳定。两例均未 attach 到 Workspace，日志 mode 为 `history`。无 surface 例是 mock 前缀，不等同 Boston 真实旧段；真实数据仍未写入或运行。

同一隔离环境还验证了群聊根 Session：22 条原始事件前缀、8 条可读消息在重启后保留，且未 attach 到目标 Workspace。活动段阶段器在历史模式代码加入后回归了 173 条事件、重启前后各 47 条消息及下一回合旧事实回忆。声明版 DSH 完整单测 893 通过、2 跳过、0 失败，lint 0 错误，生成物检查通过。固定版 DSH 首轮烟测有一次 `fetch failed`，同一新代码在新的隔离 Profile 重跑 52 步全部通过；两次烟测和各探针的 Web/mock 端口均已停止。该结果仍不覆盖真实 Boston 旧段、群成员所有 Session、附件、记忆激活与远程同步。

随后补验了来源群聊的成员 Session：首次因隔离目标模型不可用在显式 `selectModel` 处被 DSH 拒绝，私有日志正确留下一条 `needs-review`，团队状态未激活；启动隔离 mock 模型后，新目标 ID 的 21 条源事件与 7 条消息在重启后保留，原始前缀不变，Workspace 已 attach 且日志 mode=`active`。对应模型失败测试已加入，声明版 DSH 完整单测更新为 894 通过、2 跳过、0 失败。失败留下的隔离 Session 仍需未来恢复器判定，不作为可激活数据。

长期记忆另有只读清单 `team-import-memory.js`：仅列出当前 Bot、群聊和团队作用域里的 `MEMORY.md` 与主题 Markdown，映射目标作用域并计算文件大小和 SHA-256；拒绝符号链接、孤儿作用域和未知文件。`snapshots/` 是 Session 冻结提示词，`reviewed.json` 是复盘游标，均不得冒充长期记忆或原样复制。m5max 隔离 mock 来源当前活动作用域没有长期记忆文件，只有已删除群聊的归档文件；清单正确返回 0。归档、复盘游标、记忆变更 journal 和目标已有团队记忆的合并仍须另行设计与验证，清单不能作为记忆迁入完成凭证。

增加目标记忆作用域碰撞拒绝后，声明版 DSH 完整单测为 886 通过、2 跳过、0 失败；lint 0 错误、生成物检查通过。固定版 DSH 的新隔离 mock Web 烟测 52 步全部通过，两个测试端口已停止。

`team-import-memory-stage.js` 先复核团队状态摘要和长期记忆文件清单，再把 Bot、群聊、团队记忆的原始字节写入目标 Host 私有、权限为 `0700` 的未激活暂存目录。清单记录源与目标团队摘要；文件写入前后都核对大小和 SHA-256。暂存目录以排他创建，已有 `pending` 或 `staged` 目录一律拒绝重试，避免中断后覆盖部分文件。模块不修改活动团队记忆；尤其不能把暂存的 `team/MEMORY.md` 直接覆盖 m5max 已有团队记忆。归档、journal 和复盘游标仍未迁入，正式激活和故障恢复器仍待实现。

只读激活前核验 `team-import-preflight.js` 重新生成团队候选，复核源和目标状态摘要及修订号；逐一检查所有规划 Session 的私有日志为 `staged`、活动/历史模式和摘要相符，并要求调用方通过 `verifySession` 核实真实 DSH 持久化事件；重新盘点来源长期记忆并核对暂存标记及全部字节摘要。它不写团队状态，也不是激活许可：调用方尚未实现实际 Session 验证、附件验证、写入冻结或原子提交。现有 `store.save()` 在排队写文件之前即修改内存 `revision`，失败时内存可能保留未落盘的候选；正式激活不得仅将候选塞进 `rt.state` 后调用 `save()`。必须先建立排他写入屏障和可恢复的持久提交协议，并在屏障内重新运行核验。

作为激活故障闸门，`store.js` 现在识别 `<bot-home>/import-activation.pending.json`：只要文件存在或读取元信息失败，Host 在本进程内锁定为只读，不加载团队状态、不接管 `state.lock`，也不保存；即使标记随后移除，本进程仍须重启才会解除锁定。已启动的 Host 若随后看见标记，同样锁定，防止继续接受写入。正式事务必须先取得目标 Host 已停止的确认和独占锁，再创建此标记，复制并复核全部未激活文件，最后原子替换团队状态；完成或回滚均须验证磁盘指纹后移除标记并重启 Host。**当前只实现故障闸门，没有实现事务写入器或恢复器，也没有在真实 Profile 创建标记。**

写入队列另有竞态：`save()` 可在标记创建前排入快照，却在标记创建后才实际落盘。现在队列任务在临时文件写入前和原子替换前重查标记，即使锁不可用时也拒绝该写入并锁定本进程。隔离回归把写入暂停在目录准备阶段，创建标记后恢复，验证旧团队文件逐字节不变；此检查不能代替正式激活时的 Host 停止确认和独占屏障。

此修复在 m5max fork 隔离工作树经声明版 DSH 完整单测 909 通过、2 跳过、0 失败，lint 0 错误、11 条既有警告，客户端生成物 `--check` 通过；固定版 DSH 的新隔离 mock Web Profile 烟测 52/52，通过后 Web 与 mock 均停止。真实 Profile 仍未写入。

m5max 的另一份隔离 DSH Profile 验证：在启动正式 `runProfile` 前放入标记，DS Bot 未取得 `state.lock`，关闭后 `state.json` 摘要未变；探针最终删除标记。此结果只验证标记阻止读取/保存，并不证明将来事务写入器的文件顺序或回滚正确。

`team-import-agent.js` 另提供 `verifyImportedAgent`：从来源事件重新生成映射 seed，先核对阶段日志里的事件摘要，再经正式 `sessionController.resolveAgent()` 重开目标 Agent，比较持久化事件的完整 seed 前缀；允许 DSH 在其后添加生命周期事件。正式导入入口尚未提供来源事件解码器，也尚未把该校验接入激活前核验的 `verifySession` 回调。

m5max 隔离冷启动探针确认：`resolveAgent()` 本身会取得 Session 写句柄，并将 Agent 注册到当前 DSH Host；之后不可再对同一 Session 调用 `agents.resume()`，否则 DSH 报 `SessionAlreadyOwnedError`。核验器不修改 DS Bot 团队状态，但 DSH 打开 Session 时可能补写生命周期事件；其“只读”仅指不激活团队、不改原团队文件，正式流程应复用已解析的 Agent 并限制打开数量。隔离旧段重启后由 `resolveAgent()` 独立打开，122 条来源事件前缀和 30 条消息均保持一致。

来源读取改用 DSH 公共 `ctx.sessionPersistence.open(id, 'read')`：该 seam 不取得写入权，返回已验证的当前逻辑事件，旧物理格式由 DSH 后端在内存中准备。`team-import-source.js` 只允许当前来源 Profile 中已列入导入计划的团队 Session ID，先按 `stat` 拒绝过大记录，再有界读取、关闭句柄并复核同一服务实例的修订及事件数；只返回事件、数量和摘要，不返回带绝对工作目录的 header。m5max 隔离 mock 来源 10 个团队 Session 经此接口读取共 658 条事件，与此前独立解码计数相同。正式 Host 还须认证计划来源，不能接受远端自造计划。此探针没有运行在 Boston 真实 Profile；正式传输仍须定义加密分片、附件和跨设备来源摘要，不能把 mock 成功当作真实迁移许可。

附件先由 `team-import-attachments.js` 从已解码事件中枚举 `image`/`file` 内容块里的持久引用；重复引用去重，未知 `attachmentId` 位置、无效或冲突的元数据均拒绝。来源设备用公开 `ctx.attachments.readImage`、`readFileStream` 读出并核对完整 SHA-256 与字节数，缺失或损坏附件阻止迁入。该步骤只产出引用清单与验证结果，不在目标写入附件，也不改写 Session seed。目标设备必须用公共保存接口提交附件，并按实际返回的目标引用重写所有历史内容块；不能假设重新保存图片后仍保持相同 ID。

目标暂存器 `stageImportedAttachment` 用公开 `saveImage`/`saveFileStream` 保存经过来源校验的传输载荷，校验输入字节、长度及普通文件的内容地址，返回来源/目标引用映射；保存失败或校验失败不修改团队状态，可能留下未引用的内容地址对象。`remapSessionEvents` 现要求每个历史附件引用已有目标映射，并仅替换内容块中的引用；缺少映射拒绝创建 Session。活动段和历史段的阶段器及重启核验共用同一映射。m5max 两个隔离 Profile 间，真实 DSH 附件 API 对一个 PNG 和一个普通文件完成保存、重启后读取；另在 173 条 mock 来源事件中加入两个附件引用，目标暂存后以 DSH Agent 工厂创建未激活历史段，重启后事件前缀及两个目标附件均通过复核。此次两类内容地址恰好相同，不作为跨版本永远相同的保证。正式加密传输、附件数量/体积的产品策略、真实 Boston 历史及激活事务仍未完成。

附件映射现由私有 `team-import-attachment-journal.js` 持久化：保存目标对象前，按来源类型、内容地址和名字排他预留，并绑定源/目标团队摘要；成功后以目标实际引用标记 `staged`，失败标为 `needs-review`，进程中断留下 `pending`。两种状态均禁止自动重建。重启后可只从日志恢复映射并重新用 DSH 附件读取接口核对目标字节。m5max 隔离历史探针再次验证：173 条 mock 事件中的两个附件映射从磁盘恢复，历史 Agent 前缀及目标附件复核通过。日志本身不激活团队；正式 Host 仍须从完整来源事件清单证明所有引用均已覆盖，并在事务屏障内重新检查。未实现的恢复审计不能把 `pending` 或 `needs-review` 当作可重试状态。

暂存器还按真实路径拒绝将暂存放进来源或目标正式记忆目录，并拒绝符号链接形式的暂存上级目录。最终代码在声明版 DSH 下完整单测 891 通过、2 跳过、0 失败，lint 0 错误，生成物检查通过；固定版 DSH 的隔离 mock Web 烟测 52 步全部通过，Web 与 mock 已停止。这些验证没有写入真实 Profile。

群聊原文来源另行调查：m5max 隔离 mock 群的根 Session 中，用户消息正文与群缓存的 SHA-256 和字节数一致；成员 Session 中的 Bot 回复也与缓存一致。但两个 Session 没有共同的稳定群序号，且群内通知、成员间回合及滚动超过 60 条后的完整顺序未获证明。不能把这些 Session 的消息简单拼接为完整群聊。`group-history.js` 因此先提供独立的 Profile 本地、逐条哈希串联的原文日志原语：可保存超过 UI 60 条缓存的正文，识别旧缓存缺口、截断正文、尾部损坏及状态与日志序号分歧。它尚未接入日常群聊写入或导入预检；现有群聊历史仍不能据此宣称完整。接入前须解决日志与 `state.json` 两次写入之间的崩溃恢复、来源群原文到目标 ID 的映射、加密传输和多设备权威切换，并用隔离 Profile 验证。

该独立原语的本机验收：定向 4/4，通过；安装仓库声明的 DSH `0.2.1-rc.2` 测试依赖后完整单测 920 通过、2 跳过、0 失败，lint 0 错误、11 条既有警告，客户端生成物检查通过。第一次完整运行时既有锁接管测试偶发失败，单独重跑 11/11 和第二次完整运行均通过。m5max 当前 SSH 超时，尚未在该机重验或运行此次 host 改动所需的隔离 mock 烟测。没有写入真实 Profile。

m5max 恢复连通后，隔离工作树快进到 `5d6d466`，在声明版 DSH 下完整单测 920 通过、2 跳过、0 失败，lint 0 错误、11 条既有警告，客户端生成物检查通过。新建隔离 `history6148` mock Web Profile 后，完整烟测 52/52 通过；测试使用 3197/8897 端口，结束后两个端口均无监听，工作树干净。该结果只验证现有 Host 回归，日志原语仍未接入群聊写入或导入预检，真实 Profile 未写入。

为未来写入定义崩溃边界：先将完整群行和前一摘要追加到日志并 fsync，然后在同一 `state.json` 快照中保存群序号及 `historyJournal={seq,digest}`。重启后仅信任状态已提交的序号/摘要；`recover(room)` 验证这段哈希链与当前缓存，再截去完整或半写入的未提交尾部。已提交前缀缺失、摘要不符或无独占写锁时拒绝恢复；一旦状态保存过日志标记，整份日志丢失不能退化成“旧群首次初始化”。隔离单测 9/9 通过。该协议原语仍未接入 `groups.js` 与 `store.load/save`，因此尚未形成线上自动恢复；正式接入还须验证状态保存失败、并发队列、群删除、只读 Host、跨平台文件系统与 Session 重放。

随后把写入接入 `groups.js` 的唯一 `appendRoom`：首次追加前按已保存的群序号与可选摘要恢复日志；完整行先持久化，随后更新最多 60 条的 UI 缓存及 `room.historyJournal`，现有 `rt.save()` 把缓存和摘要放进同一原子状态快照。失去独占团队锁时拒绝追加。新群从序号 1 开始可保持完整原文；旧群只从现存缓存初始化，缺失的旧行或已截断的旧长文仍标为不完整。定向运行时测试核对 `state.json` 中的摘要与日志一致。群删除后的旧日志清理、已提交日志缺失时的用户恢复界面，以及跨设备传输和目标激活尚未实现；不能把原文落盘等同团队同步完成。

此写入路径在 m5max 隔离工作树的声明版 DSH 下完整单测 926 通过、2 跳过、0 失败，lint 0 错误、11 条既有警告，客户端生成物检查通过；旧测试直接手改状态生成 60 条群记录，现明确按升级前无日志团队建夹具，实际状态/日志不一致仍拒绝。新的 `live6148` mock Web Profile 完整烟测 52/52 通过，产生两份从序号 1 开始且标记完整的日志（13 与 2 条），当前群的状态序号与 checkpoint 一致；3199 端口未使用，实际测试端口 3296/8996 在结束后均无监听。额外的跨进程运行时单测验证：状态未保存的一条日志在重启后被截去，新群仍能继续追加，群状态和日志保持一致。真实 Profile 未写入，官方 App 尚未固定该 fork。
