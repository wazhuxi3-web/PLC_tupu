# 本机查询接口 · v1

应用版本 0.2.0，接口版本 1.0。运行地址 `http://127.0.0.1:4173`。集成入口统一为 **`/api/v1/`**，仅提供 GET 查询；当前没有连接 Dify。

机器可读定义见 [openapi.v1.json](openapi.v1.json)，下一阶段接入边界见 [Dify 接续开发](DIFY接续开发.md)。旧 `/api/` 查询路径供本地前端兼容，外部适配器应使用 v1。

## 调用顺序和快照一致性

先请求 `GET /api/v1/project`。没有工程时返回 `200`、`empty:true`，此时 `context.projectId/snapshotId` 为 null。已导入时可获取程序和块清单。

其余六个接口必须同时提供 **`projectId`、`snapshotId`**，取自工程响应的 `context`，不能自行生成。每次响应也带 `context`：

```json
{
  "context": {
    "apiVersion": "1.0",
    "projectId": "l0226d02",
    "snapshotId": "从工程响应复制完整值",
    "analysisMode": "offline-static"
  }
}
```

当前只加载一个工程快照；成功导入后立即切换。新导入失败时保留之前成功的快照。查询旧快照返回 `409 SNAPSHOT_MISMATCH`，调用方应重新获取工程并重新执行整个查询链，不能拼接不同快照的证据。

`projectId` 当前来自工程文件名，不是全局唯一标识，必须与 `snapshotId` 一起使用。快照标识包含来源文件清单摘要和解析配置，不承诺重复导入时保持不变。块和调用 ID 也只在该工程快照范围内有效。

## 路径

下表省略每个查询都要携带的 `projectId` 和 `snapshotId`（仅 `/project` 除外）。参数通过 URL 编码传递。

| 路径 | 业务参数 | 返回与限制 |
| --- | --- | --- |
| `/api/v1/project` | 无 | 当前快照、读取器版本、程序、块目录、调用总数、诊断和限制 |
| `/api/v1/block` | `id` | 已解析块的指令、接口和数据结构；受保护/未解析块返回 404 |
| `/api/v1/calls` | `program`；可选 `focus` 块 ID | 直接调用图，最多 160 个调用点，包含 `total/truncated` |
| `/api/v1/symbols` | `program`；可选 `q` | 符号、规范地址或注释搜索，最多 120 条，包含 `total/truncated` |
| `/api/v1/references` | `program`、`q` | 完整符号名或直接地址的读写引用，最多 300 条，包含 `scope/total/truncated` |
| `/api/v1/parameters` | `call`；可选 `focus`、`direction` | 单个调用点的实参映射与有限布尔依赖图 |

所有 ID 必须从前置查询的响应中选择；同名 FC/FB 在不同 CPU 内不能混用。

`parameters.focus` 支持形参名、节点 ID 或规范地址；`direction` 为 `upstream`、`downstream`、`both`（默认）。存在 focus 时深度上限 12、节点上限 100；达到上限返回 `truncated:true`。没有匹配节点时 `matched:false`、节点和边为空。未指定 focus 时返回本次调用的全部绑定，direction 不起过滤作用。v1 尚无分页，遇到截断应缩小 focus/q 范围并保留不完整提示。

## 参数图与证据

- `call`：具体调用点，保留调用者、目标、实例、指令位置和各参数原始值、方向、类型。
- `nodes`：节点 ID 包含调用点；列号 0～4 表示实参来源、调用前实参、形参输入、形参输出和实际输出。
- `edges`：`parameter-in`（输入绑定）、`parameter-out`（输出绑定）、`boolean-preparation`（调用前布尔赋值）、`potential-boolean-dependency`（块内潜在布尔依赖）。
- `edges[].evidence`：`blockId/network/row`，可能还有 `readRow/parameter`。通过 block 接口定位 `rows[].index`。
- `coverage`：调用者/被调用者跳过网络的诊断、被调用者已分析和总网络数。
- `warnings/semantics/truncated`：未解析项、结果含义和截断状态，必须保留到解释输出。

`row/readRow` 是反编译后的指令序号，**不是保存的 AWL 文件行号**。`coverage` 的分母是反编译结果中的 Network 数，并非整个 PLC 的覆盖率。即使 `truncated:false`，也不代表所有网络或所有影响都已解析。

`block.interface` 是树形结构，数组边界与字节长度保留，不逐元素展开。非数组的边界可能为 `[null]`，只有 `isArray:true` 时使用它们。地址规范化支持德文 A/E 到英文 Q/I；原始实参仍保留。

## 错误约定

错误返回 `{ "error":"可读说明", "code":"稳定代码", "context":{...} }`。

| HTTP | code | 调用方处理 |
| --- | --- | --- |
| 400 | `CONTEXT_REQUIRED` | 补齐当前工程与快照标识 |
| 400 | `INVALID_DIRECTION` | 使用约定方向值 |
| 403 | `LOCAL_ACCESS_ONLY` | 当前服务仅限本机 |
| 404 | `PROGRAM_NOT_FOUND` / `BLOCK_UNAVAILABLE` / `CALL_NOT_FOUND` | 重新从目录选择，或说明该对象不可解析 |
| 404 | `NOT_FOUND` | 不存在的接口 |
| 405 | `READ_ONLY_API` | v1 不接受写操作 |
| 409 | `NO_PROJECT` | 在本地工作台先导入 |
| 409 | `PROJECT_MISMATCH` / `SNAPSHOT_MISMATCH` | 刷新工程上下文，重新完成查询链 |
| 500 | `INTERNAL_ERROR` | 查本机日志，不猜测结果 |

## 本地界面专用操作

`POST /api/select-folder`、`/api/inspect-folder`、`/api/import` 与 `GET /api/import-status` 只用于本地界面，**没有作为 Dify 工具暴露**。POST 需要本地操作头和同源校验。工程选择、编码和导入由用户在工作台完成。

当前无远程身份认证、跨主机授权或多工程会话。服务只监听 127.0.0.1；保留这些限制，下一阶段按实际 Dify 部署方式设计连接。

## 点位综合查询（v1 的主要 Agent 工具）

`GET /api/v1/point?projectId=...&snapshotId=...&program=...&q=MW17`，OpenAPI operationId 为 `tracePoint`。建议 Dify 在拿到工程上下文后首先调用此入口，再根据需要查询块指令、调用点和局部参数图。

返回 `directBlocks`、`references/referenceTotal`、`relatedCalls/totalCalls` 和 `flow`。`relatedCalls` 包含具体 call、关系类别、局部布尔图和被调用块的直接引用，最多 40 条；直接引用最多 300 条。符号重名对应多个地址时 `ambiguous:true/candidates`，此时应让用户选择具体地址，不产生猜测图。

`flow` 是综合点位流程图：

- `nodes[].kind`：memory/input/constant/parameter/unresolved-local；`level` 为相对点位层级（负数上游，正数下游）；`sourceState` 区分 external-input/constant/internal/unresolved。
- `edges[].kind`：data-transfer（数值或运算结果的操作数依赖）、control-dependency（布尔/比较条件影响）、timer-dependency（定时器条件影响）、parameter-in/out 和 argument-preparation。
- `edges[].evidence` 沿用 blockId/network/row/readRow，并可能带 callId。数值传递边不表示两个点位数值一定相等，例如加法会同时依赖两个操作数。
- `sourceStatus` 是 potential-writers-found 或 no-mapped-writer；后者只是当前分析未还原来源。
- `hasCycle` 表示所展示关系包含内部循环；`sources` 为显示范围内的来源或边界节点 ID，并非已证明的最终现场来源。
- `limits` 默认 maxDepth=6、maxNodes=90、maxEdges=240；`boundary` 标出节点边界；`truncated` 必须保留。
- `diagnostics` 记录相关网络内的分段边界与未知指令；控制转移处重置推导状态，只返回可识别直线段的潜在依赖。未完整展开嵌套调用上下文。

此入口额外可能返回 `400 POINT_REQUIRED`、`400 POINT_NOT_RESOLVED`。即使有图，也必须同时考虑未解析保护块、间接寻址、地址重叠和诊断提示。

