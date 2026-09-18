# 第三方依赖与来源

## 已实际使用

- **DotNetSiemensPLCToolBoxLibrary / NuGet 4.4.10**：读取 STEP7 工程、恢复离线指令、解析接口、符号和 CALL 参数。
  - 项目：https://github.com/dotnetprojects/DotNetSiemensPLCToolBoxLibrary
  - 固定包：https://www.nuget.org/packages/DotNetProjects.DotNetSiemensPLCToolBoxLibrary/4.4.10
  - 本地审阅源码提交：`3d3eea50d9b24b53481809585f73e67f93ddb1d9`。此提交用于理解 API，不代表与 NuGet 二进制源码完全一致；实际执行的是固定版本 NuGet DLL。
  - 上游仓库 LICENSE 为 LGPL-2.1；NuGet 元数据标注 MIT，二者存在差异。本项目保留上游许可正文，不将该依赖简单声明为 MIT。本次仅生成用户本机离线包，保留许可与来源；上游许可标注差异仍保留为待澄清项。
- **SharpZipLib / NuGet 1.4.2**：读取库的压缩格式依赖；包内 nuspec 元数据声明 MIT 许可（https://licenses.nuget.org/MIT）。

依赖从官方 NuGet 下载至 `.tools/packages/`，版本和包的 SHA-256 固定在 `scripts/Initialize-Dependencies.ps1`。项目不需要全局安装 .NET SDK，读取适配器使用 PowerShell 7 的 .NET 运行环境。

保留的上游许可副本见 `licenses/`，完整下载包位于 `.tools/packages/`，审阅源码位于 `vendor/DotNetSiemensPLCToolBoxLibrary/`。这些缓存和真实工程数据均不纳入源码版本管理。

## 当前未引入

- **ARES**：仍是后续控制流、数据流方法的参考候选，没有复制其源码，也没有将其作为运行依赖。
- **Awlsim / Stp7Toolbox / plc-ai-agent**：本版本没有引入。
- **Dify**：后续接入。当前只有本机只读 HTTP 查询服务，没有创建工作流或调用模型。

Node 服务和前端无第三方 npm 依赖。有限布尔与数值依赖、点位追踪、调用点隔离、局部图查询及界面代码为本项目实现。

## 离线运行环境

离线包复用本机 Node.js v25.9.0 和 PowerShell 7 运行环境，不要求用户在线下载安装。Node.js 官方版本许可见 licenses/Node-LICENSE.txt；PowerShell 自带的 LICENSE.txt 与 ThirdPartyNotices.txt 随运行目录保留。SharpZipLib 的官方 v1.4.2 许可已保存到 licenses/SharpZipLib-LICENSE.txt。运行文件的版本和 SHA-256 记录在离线包 package-manifest.json。

