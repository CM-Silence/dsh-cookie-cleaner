# dsh-cookie-cleaner

给 DeepSeek Harness 用的 cookie 清理插件。

DSH 桌面版启动时会因为 cookie 累积撞上 431，表现为打不开、日志为 `Web authentication failed`。
该插件能在 DSH 每次退出后把发往本机 origin 的 cookie 清掉，**不动账号登录，也不动语言/模型这些本地设置**。

## 功能

- 退出后自动清理：不用再手动删 `Cookies` 文件
- 只清本机 origin：`127.0.0.1` / `localhost` / `::1` / `dsh-app`，账号域名一条不动
- 删除前先备份：报告里写明动过什么、没动什么
- 预算按 host 判：只有某个 host 自己的 `Cookie` 头超 16KB 才兜底修剪
- 三种模式：`local` 只清本机、`all` 全库清空、`off` 只观测
- 常驻约 17MB，不弹窗口，清理完立刻退出
- 命令行可随时查看结果、手动清理

## 安装

要求：

- DSH >= 0.2.1-rc.2
- Node.js >= 22（用到 `node:sqlite`；DSH 桌面版自带的是 Node 24）

`desktop` profile 被 Electron 独占，`dsh plugin --profile desktop add …` 会被拒，所以命令行装是这样：

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
pnpm add "link:<本仓库路径>"
```

再把名字加进同一个目录的 `package.json`：

```jsonc
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cookie-cleaner", "…"]
  }
}
```

也可以走 GUI：**设置 → 插件 → 从本地路径安装**，选这个目录。

装完**重启 DSH**。

> 第一次装好之后，请先完全退出 DSH → 跑一次 `node bin/clean.mjs clean`（或双击 `bin\clean-now.cmd`）
> → 再启动。因为装好的这一轮还没清过，库如果已经接近 16KB，下次启动照样会撞 431。

## 配置

打开：

```
~/.dsh/profiles/desktop/cordis.patch.yml
```

在插件那一条的 `config` 里填：

```yaml
- id: dsh-cookie-cleaner
  name: dsh-cookie-cleaner
  config:
    mode: local
    maxHeaderBytes: 14336
```

| 项目 | 默认 | 说明 |
|---|---|---|
| `mode` | `local` | `local` 只清本机 origin；`all` 全库清空（会掉登录，一定先备份）；`off` 只观测 |
| `maxHeaderBytes` | `14336` | **单个 host** 的 Cookie 头预算（Node 默认 16384，留 2KB 余量） |
| `safetyNetHosts` | `local` | 兜底范围：`local` 只处理本机；`any` 也修剪超预算的账号域名 |
| `safetyNetKeepDays` | `30` | 兜底时，这个天数内新建的 cookie 不删 |
| `vacuum` | `false` | 清完是否 VACUUM（只会拉长占库时间，建议保持关闭） |
| `backups` | `5` | 保留几份备份 |
| `localHosts` | 见上 | 哪些 host 算"本机 origin" |

改完重启 DSH 生效，不需要重装。

## 使用

装好之后不用管，它自己会在每次退出时清一遍。想看结果时：

```bash
# 上次清成什么样 + 当前库大小（DSH 在跑也能看）
node bin/clean.mjs status

# 只算不改：如果现在清，会删几条
node bin/clean.mjs clean --dry-run

# 真清（DSH 必须已退出）
node bin/clean.mjs clean
```

`status` 会打印上次的 `before / after`、删了几条、按 host 的超预算提示，以及备份路径。

## 数据

状态与报告保存在：

```
~/.dsh/cookie-cleaner/
```

里面是 `last-report.json`（完整报告）、`host.log`（每次启动/清理一行）、`backups/`（改动前的库副本）。

> ⚠️ `backups/` 里是完整 cookie 库副本，等同于登录凭证，不要外传、别提交进仓库。

## 说明

cookie 库在应用运行期间被 Chromium 独占（读、改名、删除全是 `EBUSY`），所以清理只能发生在
**上一次退出之后、下一次启动之前**。插件会在启动时挂一个很小的哨兵（`wscript`，约 17MB，不弹窗），
盯着这次 DSH 的进程；它们一消失就清一次。

清理范围是发往本机 origin 的 cookie —— 也就是每次启动新发的临时凭据。账号 cookie 不参与
发往本机的请求，动了只会让人掉登录，所以默认一条都不碰。

## License

MIT
