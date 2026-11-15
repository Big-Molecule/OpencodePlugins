# 在校园网内的电脑上安装 ScienceDirect 插件

目标机器：工位上物理接入校园网的那台 Windows 电脑。
用途：利用校园网出口 IP 直接获得 Elsevier 机构授权，验证 ScienceDirect 检索与全文获取。

## 前提

- Node.js 18+ 与 npm 在 PATH 中（`node -v`、`npm -v` 有输出）
- 已安装 OpenCode 桌面版或 CLI
- 已有 Elsevier 个人 API Key（<https://dev.elsevier.com/apikey/manage>）

## 步骤

### 1. 克隆仓库

```powershell
git clone git@github.com:Big-Molecule/OpencodePlugins.git
cd OpencodePlugins
```

如果没有配置 SSH key，改用 HTTPS：

```powershell
git clone https://github.com/Big-Molecule/OpencodePlugins.git
cd OpencodePlugins
```

### 2. 安装依赖并跑测试

```powershell
npm ci
npm test
npm run typecheck
```

预期：全部测试通过（约 79 项），类型检查无报错。

### 3. 安装插件到 OpenCode

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

该脚本会：

- 把 V2 插件复制到 `%USERPROFILE%\.config\opencode\plugins\`
- 在 OpenCode 配置目录安装 `@opencode/plugin` 与 `zod` 依赖
- 同步 `plugins/lib/` 与 office 相关脚本

### 4. 重启 OpenCode

安装完成后重启 OpenCode，或在会话中执行 `/reload`，让插件被加载。

### 5. 配置 API Key

在 OpenCode 里直接对模型说：

```text
用 sciencedirect_configure 保存这个 Elsevier API key：<你的key>
```

或使用环境变量（不写入会话历史）：

```powershell
[System.Environment]::SetEnvironmentVariable('ELSEVIER_API_KEY','<你的key>','User')
```

设置环境变量后需要重启 OpenCode 才生效。

### 6. 验证机构授权

关键前提：**这台电脑必须在校园网内**，且 OpenCode 的请求不经过任何境外代理或 VPN。

先看状态：

```text
sciencedirect_status
```

应看到 `API key: configured`，且 `Institution token: not set` 属正常。

再验证 IP 认证：

```text
sciencedirect_authenticate
```

判断标准：

| 返回 | 含义 | 下一步 |
|---|---|---|
| `authentication succeeded` | 校园 IP 已被识别 | 继续第 7 步 |
| 列出多个机构选项 | 该 IP 对应多个订阅账户 | 选一个 `choice` 再试 |
| `AUTHENTICATION_ERROR` | IP 未被识别为订阅机构 | 见文末排查 |

### 7. 验证检索与全文

检索：

```text
sciencedirect_search query="solar forecasting" open_access_only=true limit=3
```

应返回标题、作者、DOI、PII 和配额信息。

全文并落盘：

```text
sciencedirect_article identifier="10.1016/j.adapen.2025.100250" mode=full_text output_path="papers/test.txt"
```

判断标准：

| 结果 | 含义 |
|---|---|
| 返回正文，且文件已保存 | 全链路打通 |
| `403 ... insufficient` | 机构授权未生效，参考排查 |
| 只返回 metadata/abstract | 该文章无全文权限，换一篇开放获取论文试 |

## 排查

**A. `sciencedirect_authenticate` 返回 403**

- 确认电脑物理在校园网内：访问 <https://ipinfo.io/json>，看 `org` 是否为学校网络
- 关闭所有代理软件（Clash、v2ray、Tailscale exit node 等）
- 确认没有连到境外 VPN

**B. 检索返回 401 `AUTHORIZATION_ERROR`**

这是**产品未授权**，不是 Key 无效。同一把 Key 在 Scopus 端点是通的，说明 Key 本身有效。

需要联系学校图书馆或 [Elsevier API 支持](https://service.elsevier.com/app/contact/supporthub/researchproductsapis/)，确认：

- 学校订阅是否包含 ScienceDirect API / TDM 权限
- 该 API Key 是否需要单独启用 ScienceDirect 服务
- 校外访问是否需要申请 Institutional Token

**C. 全文只返回摘要**

正常行为。ScienceDirect 会按当前权限自动降级。若目标是开放获取论文仍只拿到摘要，说明机构授权链路仍未打通。

## 不要做的事

- 不要把 API Key 提交到仓库或写进 `opencode.json`
- 不要共用他人的 API Key
- 不要用浏览器 Cookie、CARSI 会话或校园账号密码冒充 API 授权
