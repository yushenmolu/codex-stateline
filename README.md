# Codex 状态面板

Windows 本机 Codex companion 面板通过 Codex 桌面事件显示当前对话状态与已确认的 token 计数，并在独立窗口显示整个本机 Codex 的用量和当天柱状图。原生桌面的鹈鹕测试仅提供 Cockpit 动画，旧版本作品仍可查看。Web 保留静态 SVG、SVG 动画、HTML/CSS 动画及 Cockpit 基准。不会写入 Codex 配置、shell profile 或 hooks。

本版本已于 2026-10-18 经用户确认验收，相关计划与修复记录见[归档索引](docs/archive/README.md)。本地验证日志和截图保留在原 `Temp` 目录，不纳入 Git；归档不表示现有旧服务已经加载新版。

## 启动

需要 Windows PowerShell 5.1、系统 WPF 和 Node.js 18+；运行基准还需要可用的 `codex.exe` 及其现有登录/relay 配置。项目没有新增依赖，不需要安装浏览器组件。执行 `npm run desktop`，或双击 `Start-Codex-Widget.vbs` / 已创建的桌面快捷方式，打开原生 WPF 悬浮窗。移动项目后需更新快捷方式。

`npm run desktop` 显式使用 `powershell.exe -STA`；原 VBS 路径保持不变，Windows PowerShell 5.1 默认以 STA 启动。启动器在同一个 STA 进程中调用 `scripts/native-widget.ps1`，启动主窗时不创建 Edge 窗口；Cockpit 结果弹窗加载动画时使用无独立窗口的受控 Edge 进程及临时 profile，旧 HTML 动画历史仍可主动打开独立预览。主窗标题为 `Codex 状态`，宽 `380` DIP、初始高约 `320` DIP，并按 `WorkArea` 限制；可用高度不足时主窗滚动，避免控件被裁切。拖动标题文字移动，点击“置顶/浮动”切换置顶、“×”关闭。主窗标题区固定提供“鹈鹕测试”（`Results`，只打开结果窗，不自动运行）和“设置”（`Settings`，打开唯一的独立设置窗），正文提供“用量统计”（`Usage`，打开独立用量窗）；旧运行/刷新入口保持隐藏。设置窗只编辑下一次运行的模型、推理强度和作品形式内存草稿，并与结果窗内同一组控件双向同步；关闭设置窗不取消运行，也不修改 `config.toml`、持久化草稿或历史/已经验证的作品。结果窗的“开始生成”才提交运行；关闭结果、设置或用量窗保留主窗，关闭主窗会关闭这些子窗，随后启动器才执行服务清理。

启动器通过 `/api/capabilities` 核对 `product: codex-companion`、整数 `protocolVersion: 1`、UUID `instanceId`，以及 `configured-defaults`、`pelican-svg-v2`、`versioned-scoring` 三项能力。兼容服务可复用，关闭窗口不会停止它。端口被旧版、未知或不兼容服务占用时显示原生诊断并停止启动；请手动确认和停止占用者，启动器不会结束它。监听状态查询失败也不会被当作空闲端口。用量与实时接口随服务代码发布：重新打开窗口时若仍在复用旧服务，新功能不会自动加载。原生客户端以 `live-telemetry-v1` 能力识别实时接口；缺少能力时明确显示“历史日志 · 非实时”。旧服务没有用量接口时，总用量显示不可用。启动器不会自动重启服务或结束未知 PID。

空闲端口由启动器启动隐藏 Node 进程，记录 Process 对象、启动时间、监听端口的 `OwningProcess` 和首个已确认 `instanceId`。关停先重新核对这些身份，再获取 nonce，并在发送随机 shutdown token 前再次核对。身份变化、实例替换或核对失败会撤销旧 token，保守保留未确认的进程并报告清理风险。正常关停等待最多 10 秒，只有身份仍匹配时才对自有进程树执行 `taskkill /T /F`。token 只临时加入子进程环境，启动后恢复父进程原值，不写配置或显示到面板。强制关闭启动器或断电不能保证清理。

原 Web 面板仍可通过 `npm run dev` 后打开 http://127.0.0.1:4173 使用。服务仅绑定 `127.0.0.1`；手动启动的服务用 `Ctrl+C` 停止。

## 对话实时信息

原生主窗通过独立的 `GET /api/live` 接口读取 Codex 桌面现有 IPC 事件的内存快照，不读取会话日志来推算实时状态。本机适配器只订阅现有线程的状态、身份和已确认用量，不创建或恢复对话，不发送模型请求，不接管线程所有权。订阅可能延后已加载线程的闲置卸载；切换固定对话、停止服务或连续 8 秒没有实时 API 请求时释放本连接的订阅。

自动跟随仅在能确认唯一活动主对话时显示用量；多条对话同时活动会明确提示，不能用“最近日志”猜测当前窗口。固定对话按精确 UUID 订阅，与历史日志下拉及总用量独立。所有候选完成发现和快照同步后才发布数据；连接中断、修订缺口、身份不明、超时或超限时清除实时数据，恢复后重新核实。该适配器对应本机已安装 Codex 桌面的 Windows 私有 IPC 协议；桌面未运行或协议不兼容时显示实时源不可用。

当前桌面源提供的是“会话累计”计数，不包含代理线程。输入包含缓存输入及多次请求中重复发送的输入，不是当前上下文占用；缓存输入和推理输出分别属于输入、输出的子集，不能再次相加。会话累计可能包含当前日志之前的基线，因此不一定等于本机扫描可核实的历史响应合计，也不等于账户账单。只有上游报告新用量时数字才更新，不承诺逐 token 推送。计数必须是非负安全整数，且输入加输出等于合计；矛盾的完整计数不发布。

速度显示为“观测均速 ≈ token/s”：用同一活动对话两次有效累计输出的差量除以观测时间，包含工具、等待和用量上报延迟，不代表模型逐 token 流速。提示提供确切输出差量、秒数及观测起止时间。采样窗口最多 120 秒，至少间隔 1 秒；超过 60 秒无新计数更新、计数回退、发现异常观测时差、断连或活动结束时清除估算并显示“待采样”。相同计数的重复事件不刷新速度或延长其有效期。适配器每 120 秒重新连接核实来源，重新连接后需要重新采样；连续 8 秒没有实时 API 请求仍会释放订阅。短回复若只在结束时上报一次计数，或最终计数与空闲状态同时到达，可能始终没有足够的活动采样，不能保证每次回复都有速度。

活动状态显示“运行中”；缺少执行证据的模型、推理强度、开始时间和耗时显示“未确认”或 `—`，不会拿配置默认值填充。当前上游没有可核实的请求生成时长或流式计时，无法给出精确模型速度。实时接口只公开允许的状态和计数元数据，不公开消息正文或原始 IPC 快照。

旧 Web 和无实时能力的旧服务继续使用日志遥测，明确属于历史信息。日志目录为 `%CODEX_HOME%\sessions`；未设置时使用 `%USERPROFILE%\.codex\sessions`。支持平铺和 `YYYY/MM/DD` 目录。日志选择表示最近活动日志，不保证绑定当前聊天窗口；旧 Web 速度是轮询 usage 的估算，旧原生服务的完整轮次平均速度包含工具及等待，均不能当作精确模型流速。数据缺失、身份冲突或过期时显示不可用。

## Codex 总用量

点击原生主窗的“用量统计”，在独立的“Codex 总用量”窗口查看全部本机 Codex 对话的累计输入、输出、合计、范围滑块、柱状图和扫描进度。用量窗初始为 `420 × 400` DIP，按 `WorkArea` 限制并支持短屏滚动；重复点击入口聚焦同一窗口。点击“×”或按 Escape 只关闭用量窗，后台采集与主窗轮询继续；主窗进程仍在时，重新打开保留已选时间范围并显示最新快照。固定、切换或找不到某条对话不会改变总用量的统计范围。后端以 `GET /api/usage` 提供快照；可选 `?taskId=<canonical UUID>`，返回 `overall` 与 `selected` 块。`overall` 汇总 `sessions` 和 `archived_sessions` 中所有可核实的根对话及代理线程，不等于云端账户或账单总额；`selected` 仅供历史对话统计，不会覆盖实时卡片。

现代记录以每个响应的 `payload.usage` 为准，按 `response_id` 去重。旧版原生 `token_count` 则核对线程累计计数，只加入可验证的单调增量；重复累计快照不增加总量，`last_token_usage` 不直接累加。新旧格式混合时，通过可核实的累计区间排除已被现代响应覆盖的部分；分叉继承、计数回退或覆盖区间不明时保留缺口提示，不猜测补齐。相同的普通 `sessions`、`archived_sessions`、`.jsonl` 和 `.jsonl.zst` 副本只计一次；缓存输入、推理输出等子集不重复相加。`responsesCounted` 保持现代响应数，旧版增量单列为 `nativeIncrementsCounted`，不把累计差量冒充真实响应。日期图按源记录确认时间记账：现代响应使用记录时间，旧版增量使用累计区间的结束时间；跨日才确认的增量归入确认日，不代表每个 token 的实际产生时刻。首次扫描在后台有界进行，内存保存偏移和索引，不写持久账本；数据量大时可能先显示读取中，不能承诺首次打开即得到完整总量。

用量卡提供五档滑块：今天、最近 7 天、30 天、90 天、全部记录，默认选中今天。滑块只切换范围合计和堆叠柱状图，上方输入、输出、合计仍显示全部本地已核实用量。输入为薄荷绿、输出为金色；鼠标悬停或键盘聚焦柱体可读取精确时间和 token 数，滑块可用左右方向键切换。图表按本机时区及日历日期统计，今天从本地零点到次日零点，每经过 2 小时一桶；夏令时日保留真实的 23/25 小时长度。7 天逐日、30 天每 3 天、90 天每 7 天，全部记录最多 14 桶。partial 中没有已核实记录的范围、空桶与峰值保持未知（`—` 或点），只有覆盖完整时才能把空桶计为零；图表下方显示扫描及计量记录的覆盖情况。

`overall.timeline` 为可选快照字段，由后台和总用量同时汇总；HTTP 查询和移动滑块不会重新读取日志，旧服务缺少 timeline 时仍可显示已有的有效总数。兼容旧四档 UTC 快照，但不从旧范围推导今天或补零。日期归属使用同一去重响应所有保留副本中最早的有效时间；来源回滚时重新确定。发现文件的扫描尚未结束时继续使用忙调度，避免每个新文件后等待一秒，所有原有文件、字节和响应上限保持不变。

达到全局扫描上限后停止发现、解码和新增计量，继续有界核对已计入文件的身份及修改状态；完整核对周期才能延续统计有效期，文件删除、改写、不安全或读取失败时撤回对应贡献，并保持“已统计部分”。核对停滞时仍会按过期规则隐藏数据；跨天重新汇总当天范围。持续写入的文件在此模式下可能被撤回，完整历史仍受既有扫描上限约束。

有效且已知为零显示 `0`；覆盖不完整但已有有效已验证计数时，显示该已验证子集并明确标注“已统计部分”，不能称为完整历史。`loading`、`unavailable`、`stale` 或 `usage` 为 `null` 时显示 `—`；这包括缺少可用数据、旧格式、计数冲突、读取失败或命中上限等无法给出有效值的情况，不会伪装成零。压缩帧边界兼容路径最多暂存 8 MiB；较小的 round budget 会进一步降低该上限，超过上限的帧所在文件会撤销已读贡献、释放解码资源，并报告 `partial` / `budget_exceeded`，继续扫描其他文件；文件数、响应数和总解码量等全局上限仍会停止扫描。Node.js 没有内置 zstd 解压能力时，`.jsonl.zst` 候选文件会明确排除并报告 `compressed_unsupported`；Node.js 18 因此只统计未压缩日志，Node.js 26 可使用内置 zstd，不新增依赖、不改变最低 Node.js 版本。旧服务没有 `/api/usage` 时，原生窗仅将本地总用量标为不可用，当前会话遥测继续兼容。

## 鹈鹕基准

Web 默认保持静态 SVG；原生桌面新运行仅使用下述 Cockpit 模式。静态题集及评分版本为 `pelican-svg-v2`，只有 `pelican-svg` 一道题，固定原始提示词：

```text
Generate an SVG of a pelican riding a bicycle
```

原始来源：https://simonwillison.net/tags/pelican-riding-a-bicycle/

原生主窗的“鹈鹕测试”只打开结果窗，不会自动运行；只有结果窗的“开始生成”或 Web“启动基准”才会调用模型。模型、推理强度和作品形式由下一次运行的内存草稿决定；主窗“设置”与结果窗对应控件是同一草稿的同步视图。只要主窗进程仍在，关闭设置窗或结果窗会保留内存草稿；关闭主窗或重启原生客户端后不保留。单独重启服务未必清除该草稿。这些操作不会改写 `config.toml`、历史或已完成作品。模型和推理强度各自默认沿用配置（`configured`）；选择显式值才覆盖对应 CLI 参数。子进程继承服务进程的环境，包括 relay 相关环境变量与 `CODEX_HOME`，沿用用户配置，不展示环境。配置默认值与日志中的会话模型/推理强度独立显示：服务只读 `CODEX_HOME/config.toml`（未设置时使用 `%USERPROFILE%\.codex`）的顶层 `model`、`model_reasoning_effort`，两项状态独立；有顶层 profile 选择器、语法不支持、重复键、非法值或文件安全检查失败时显示未知。缓存最多每 5 秒读取一次，成功观测超过 15 秒未刷新则为过期；读取失败不影响独立遥测或 benchmark 不可用状态。显示的默认值不会加入历史，也不会把 `configured` 改成显式参数或可比较证据。通过 Explorer 双击启动时继承 Explorer 的环境，可能与终端中的 relay 环境不同；若 relay 仅在当前终端设置，请从该终端执行 `npm run desktop`。更改系统环境后，已运行的 Explorer 或服务可能仍保留旧环境，需重新启动相应进程。复用已有服务时继续使用该服务启动时的环境。

原生预览把通过检查的完整 SVG 或单个 SVG/XML 代码块转换为 WPF 绘图，源码始终用纯文本展示。支持受限的基本几何、路径、纯色填充/描边及数值变换；不保证完整 SVG 标准兼容。脚本、事件、DTD、外部引用、图片、链接、CSS、滤镜等会被拒绝，不会自动加载文件或网络资源。不支持或超限时保留源码并显示预览错误；预览失败不等于模型运行失败。Web 面板沿用 Blob 图片预览及纯文本源码，识别静态、动画和旧三题历史的原始 case/rubric，评分提交使用运行自己的版本；可选择静态 SVG、SVG 动画和 HTML/CSS 动画模式。动画 Blob 仅接受受限 rotate/translate `animateTransform`，拒绝脚本、外部引用和其他动画元素，无法安全预览时保留源码。Web 预览不等同于原生渲染器的几何与预算验证。

对话实时信息与 Codex 总用量是独立区域，连接中、没有活动对话、数据不可用、过期和服务断连分别呈现；断连时相应区域显示不可用。总用量按上一节区分 `loading`、`unavailable`、`stale`、`usage = null` 与带有已验证子集的 partial：前四者显示 `—`，partial 显示已验证子集并标注“已统计部分”。历史响应受原生客户端 16 MiB 上限约束，超限会显示历史错误，不保证所有现有历史都能一次加载，也不覆盖历史文件或影响独立实时信息。基准提交超时可能表示结果未知，应先刷新状态，避免重复运行。明确的结构化 CLI 错误可区分认证失败、限流、模型不可用；未知退出仍是 `process_failed`，不会凭模糊消息断言 relay 故障。界面不显示原始 stderr、凭据或 relay 地址。

Web 可主动选择 SVG 动画模式，原生结果窗仍兼容旧动画历史；题集及 rubric 为 `pelican-svg-animated-v1`、case 为 `pelican-svg-animated`；请求缺省仍为静态。动画题要求旋转车轮和上下运动的鹈鹕，评分包含有效运动及子集约束；静态和动画版本不混合比较。原生预览支持本地 `use` 引用及受限 rotate/translate `animateTransform`，每目标最多一个动画，静态定位放在父组；不支持 CSS、事件触发或其他 SMIL 特性。原生限制包括 262144 字节 UTF-8 / 262144 XML 字符、4096 源元素、深度 32、use 引用栈 16、展开后最多 64 动画目标、每动画 2–32 values、总 values 2048；dur 为 0.05–60 秒、begin 为 0–60 秒、repeat 为 1–1000 或 indefinite。窗口最多 30 FPS，隐藏、切换、关闭释放播放；动画题提示词使用更小的 16 目标、2–8 values、1–6 秒子集。超限或不支持显示错误，保留源码；旧静态输出不人为添加动画。自动跟随最新默认开启，手动选择历史后保持所选运行，可恢复自动跟随。

每题手动填写正确性、一致性、约束遵循三项 1–5 分；整个运行评分完整后可设为基线。轮询保留尚未保存的评分草稿。旧 `pelican-v1` 三题历史保留，使用其原题集和评分版本；不同版本不混合比较。比较至少需要前后各五次兼容的完整评分运行，模型、推理强度、CLI 和题集等需匹配；使用任何“沿用配置”值的比较均为证据不足，因为实际配置可能变化。单次运行或单次比较不能证明模型降智。

## 本地数据与安全

基准运行与评分保存在 `%LOCALAPPDATA%\codex-companion\benchmark.json`。服务重启会把未完成运行标记为 `interrupted`。不要将数据文件上传或提交。基准使用临时目录、只读 sandbox 和有限输出，依赖本机 CLI 登录状态；面板不读取或修改凭据。服务检查 Host、Origin、Fetch Metadata、nonce、JSON 和请求结构，并提供 CSP、`no-store` 与 `nosniff`。请确保本机用户目录权限可信。

## 验证

使用显式测试文件验证后端与共享模块；不要直接依赖可能扫描 `Temp` 备份副本的宽泛 `npm test`。以下命令包含用量汇总测试：

```powershell
node --test tests/benchmark.test.js tests/html-preview.test.js tests/server.test.js tests/task-summary.test.js tests/telemetry.test.js tests/usage-summary.test.js tests/live-telemetry.test.js tests/desktop-live.test.js tests/speed.test.js
npm run build
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File tests/native-widget.selftest.ps1
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File tests/native-launcher.selftest.ps1
```

原生 UI selftest 覆盖主窗标签、独立设置窗、共享下次运行草稿、独立用量窗的复用/关闭/重开、关闭期间快照更新、范围保留、实时状态与全局用量隔离、五档滑块及旧四档兼容、精确柱体提示、未知/零值和短屏滚动；实时 API 测试覆盖事件源断连、候选歧义、补丁重同步、固定切换竞态及日志数据不能覆盖实时卡片。速度测试覆盖差量及分母核实、超过旧轮询窗口的更新间隔、无变化事件不续期、过期清除、回退和重连重采样；原生测试核对估算标记、精确提示和旧请求均速兼容。启动器 selftest 继续核对能力协议、监听 PID、启动时间/PID 复用、实例替换、nonce 获取期间换代、复用服务隔离及终止资格。相关测试不调用真实模型，不读写用户历史；需要 fixture HTTP 的预览测试会启动临时的测试自有服务并使用临时资源，由测试自行清理。上述命令只说明应执行的检查，测试通过与否以实际输出为准，也不代替实际 DPI/WorkArea、真实 relay 或人工 UI 验收。`scripts/native-widget.ps1` 的 `-Fixture` 禁用实时请求，`-SelfTest` 运行 UI 自测，`-ScreenshotPath` 可配合 fixture 保存截图。SVG 和原生预览的既有 selftest 仍按各自脚本单独运行。

人工验收：在实际 DPI 下检查主窗实时源、会话累计标签及不可用状态；点击“用量统计”，检查独立用量窗的全局输入/输出/合计、今天的范围合计、五档柱状图及覆盖状态、缺失值、短屏滚动、重复打开只聚焦同窗、Escape/关闭后重开保留范围并展示最新数据；检查固定对话的独立性、拖动和置顶。“鹈鹕测试”只能打开结果窗且不自动运行；“设置”只能打开一个独立设置窗，并与结果窗的下次运行模型、推理强度和作品形式双向同步，不改写 Codex 配置或历史；“开始生成”才提交运行。结果窗检查预览/源码、版本化评分、草稿保留、取消和证据不足状态。关闭主窗后确认全部子窗关闭、自有服务退出、复用服务仍运行；旧服务占用时应只出现兼容性诊断。

## 回滚

恢复本次变更前备份的 `scripts/start-floating-widget.ps1`、`package.json` 和 `README.md`，移除本次新增的 `tests/native-launcher.selftest.ps1`，即可回滚启动器工作包。完整原生方案回滚还需由后端/UI 负责人恢复各自文件；不要删除基准历史或修改 Codex 配置。恢复旧 Edge 启动器后需保留其原浏览器运行条件。VBS 文件与路径无需修改。

本次集成回滚：从集成备份仅恢复 `src/server.js`、`src/public/app.js`、`README.md` 和 `package.json`；不要覆盖其他工作包仍在修改的文件，不修改配置、凭据或历史。

## HTML/CSS 动画集成

Web 模式选择默认静态 SVG；HTML 模式为 `html-animated`，题集和 rubric 均为 `pelican-html-animated-v1`，case 为 `pelican-html-animated`。模型和推理强度继续分别沿用 configured，服务不会因新增模式写配置或更换认证。历史依据自身版本评分；四种版本隔离比较，configured 仍表示证据不足。

HTML 启动及独立预览要求服务同时提供 `pelican-html-animated-v1` 和 `isolated-html-preview-v1`。旧服务缺少能力时显示“当前服务不支持 HTML 动画预览”，其他功能继续可用。预览 URL 固定为 `http://127.0.0.1:4173/preview#v=1&instanceId=<UUID>&runId=<UUID>`；服务重启后旧 URL 显示实例错误，须从当前面板重新打开。

回答必须为完整严格 XML 写法的 XHTML 文档，使用受限 HTML、SVG 几何和 CSS keyframes；没有生成 JavaScript、资源引用或任意 HTML 兼容能力。上限为原始回答 131072 UTF-8 字节及 UTF-16 字符、1024 元素、深度 24、16 个实际动画目标；更多结构和 CSS 预算以注册提示词为准。不剥离围栏、不修复文档。独立 frame 经固定协议验证，在 sandbox 和 CSP 下重建通过验证的内容。拒绝预览仍保留纯文本源码，已完成运行可人工评分；兼容性失败、render_timeout 或基础设施失败不能直接判成内容违规而赋 2 分。Web 结果中提供三项完整的 1–5 分锚点。

真实 Edge smoke 由 root 串行执行：

```powershell
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File scripts/html-preview-smoke.ps1
```

也可运行 `npm run test:html-preview`。它使用 WP2 的 `tests/fixtures/html-preview.js`，默认导出名 VALID_HTML，可通过 -FixtureName 指定其他正向共享导出；fixture 服务通过 stdin JSON 行 select/state/empty/list/close 控制，HTTP 没有测试注入端点。4173 已占用会失败，不能复用或结束未知服务；没有真实模型调用或历史写入。

smoke 先通过生产 BrowserPreview.SetTargetAsync/StopAsync 验证无调试参数启动与清理，再通过内部测试构造器启动独立 Job/profile 的 CDP Edge，使用 .NET ClientWebSocket。它通过 DOM/CSS 对比 computed transform，保存正常、等待、空回答、失败、实例重启截图及 layout，记录 Network/Page/Target/Log/Runtime 异常与下载事件；不执行 Runtime.evaluate 或 Runtime.callFunctionOn。证据默认保存到 Temp/cockpit-html-evidence-*，可用 -EvidenceDirectory 指定。测试 profile 检查路径和重解析点后删除，清理失败需保留证据。此脚本入口本身不表示真实浏览器检查通过；恶意 fixture、OOPIF 观测兼容性、手动关窗与高负载关闭等仍需 root 在交付审查中核实。

`npm run build` 增加 preview.js 与 preview-frame.js 语法检查；语法通过不替代真实动画、隔离和生命周期验证。原生测试继续运行 tests/native-preview.selftest.ps1、tests/native-widget.selftest.ps1 及既有 SVG/launcher selftest。

WP4 回滚只恢复集成前备份的 src/public/app.js、src/public/index.html、src/public/styles.css、package.json、README.md，并移除本工作包新增的 scripts/html-preview-smoke.ps1、tests/helpers/html-preview-fixture-server.js。不要覆盖后端、预览或原生工作包的文件，不删除历史或修改 Codex 配置。

## Cockpit 原始提示词模式

原生桌面新运行仅提供 `cockpit`；运行完成后自动在结果弹窗加载动画，打开已有结果、隐藏后显示及关闭后重开也会加载。播放/暂停可直接点击画面中的作品按钮，无需打开独立动画窗口。“重新加载动画”在弹窗内重试失败的预览；已正常播放的同一作品不会因点击而重新启动。隔离或读取失败仍显示错误，同一失败结果不会因后台轮询反复启动浏览器。Web 保留现有静态 SVG 默认选择，并提供可选 Cockpit 模式。题集与 rubric 均为 `pelican-cockpit-v1`，case 为 `pelican-cockpit`；启动要求服务提供 `pelican-cockpit-v1` 和 `cockpit-preview-source-v1` 能力。来源为 [jlcodes99/cockpit-tools，提交 b0d88627](https://github.com/jlcodes99/cockpit-tools/tree/b0d88627)，使用该上游原始提示词：

```text
创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制
```

这是独立的新版本，历史按自身 case/rubric 展示与评分，不与旧静态、SVG 动画、严格 HTML/CSS 子集或旧三题版本混合比较。三项评分各为 1–5 分，关注有意义的 HTML/SVG、可辨的鹈鹕与自行车骑行关系、可辨且连贯的 2D 动画，以及原始提示词要求；不套用旧严格 XHTML、CSS 或 SMIL 子集约束，不要求模型运行测试。单次测试或比较不能保证或证明模型智力、降智或 IQ 变化。模型、推理强度及现有登录/relay 行为继续沿用原配置，不新增依赖或修改认证。

普通 Web 对 Cockpit 结果仅提供纯文本源码、结果与版本化评分；使用原生桌面受控预览查看动画，Web 不提供执行生成脚本的预览链接。旧 HTML/CSS 模式的独立预览链接保持原行为。Cockpit 原生预览阻断外部网络并离线运行，不加载动态外部资源，保留生成内容中的内联样式和 JavaScript。提示词中的“不要有任何限制”不移除预览隔离；预览兼容性、外部资源阻断、超时或基础设施失败不能直接认定内容违规。

本 Web 工作包只执行 `node --check src/public/app.js` 语法检查；原生和后端测试由各自负责人维护，语法检查不代表真实 UI、动画或隔离验证通过。回滚时仅从本工作包 Temp 备份恢复 `src/public/app.js`、`src/public/index.html`、`README.md`，避免覆盖其他负责人文件或后续修改。
