# dsh-smb-picker

在 DSH 输入框左侧加一个 **SMB** 按钮：直接浏览共享目录，勾图，进草稿。手机不再需要「先在文件管理器里把图从 NAS 下载下来，再从聊天框上传一遍」。

字节走的是 DSH 所在那台机器 —— SMB 由 Host 读，浏览器只负责挑名字，选中后按官方草稿附件通路（`conversation.createDrafts` + `inputActions.addAttachments`）进输入框。上传、准入、序列化全部复用官方实现，插件不碰。

## 为什么不是「挂载」

本机没有 `mount.cifs`、没有 cifs 内核模块、也没有 sudo，所以走用户态协议栈。

后端一开始用纯 JS 的 `smb3-client`，它对一台 Samba NAS 能完成 NTLMv2 认证、能枚举共享、能 `stat`，但**每一次目录查询都被拒**（`STATUS_OBJECT_NAME_INVALID`）。抓下来的请求字节与 MS-SMB2 §2.2.33 逐字段对过，完全合规，Samba 就是不收。

换成 Samba 自家协议栈的 Python 实现 `smbprotocol`，同一台机器一次就读通了。所以现在的分工是：

| 动作 | 走哪套 |
|---|---|
| 枚举共享 | `smb3-client`（它的 DCE/RPC 实现是好的） |
| 列目录、取文件字节 | `smbprotocol`（`lib/smb_worker.py`，一次请求一个短进程） |

每次请求起一个 Python 进程看起来笨，实测列一层目录 0.7 秒、取一张 0.9 MB 图 1.8 秒 —— 选图这个场景够用，而且不必维护常驻进程、也不怕泄漏。

凭据通过 **stdin** 传给 worker，不进 argv、不进环境变量，`ps` 和 `/proc/<pid>/environ` 都读不到密码。

## 安装

```bash
cd <这个目录>
npm install
python3 -m venv .venv && .venv/bin/pip install smbprotocol   # 后端需要
```

要 `python3` ≥ 3.9 和能建 venv 的 `python3-venv`。`.venv` 就在插件目录里，跟着插件走。

然后把它挂进 profile —— 二选一：

```bash
# A. 从 GitHub 装（快照，改了要先 push 再重装）
dsh plugin --profile web add github:<owner>/DeepSeek-smb-picker

# B. 本地开发（link，改完重启即生效）
#    ~/.dsh/profiles/web/package.json：
#      dependencies 加 "dsh-smb-picker": "link:<这个目录的绝对路径>"
#      dsh.profile.bundles 末尾加 "dsh-smb-picker"
cd ~/.dsh/profiles/web && pnpm install
```

最后重启 `dsh web`，硬刷页面。

`cordis.patch.yml` 自带一行插入注册（specifier 是相对路径 `./lib/index.js`，profile 的 symlink 形态下只有相对路径能被 `client-modules` 解析到包根，包名会静默丢掉 `client.js` —— 按钮不出现、Host 半边却正常，这个坑踩过）。

## 第一次用

点输入框左边的 **SMB** → 齿轮 → 填：

| 字段 | 说明 |
|---|---|
| 名称 | 显示在面板下拉里，随便写 |
| 主机 / IP | 共享所在机器，例如 `192.168.1.10` |
| 端口 | 默认 445 |
| 共享名 | 那个共享的名字，例如 `gallery` |
| 用户名 / 密码 | Windows 账号。本地账号「域」留空 |
| 起始子目录 | 可空。填了就从这里开始，比如 `outputs` |

「保存并测试」会立刻连一次并列出可见共享数。凭据存在 `~/.dsh/smb-picker.json`（0600，明文 —— 和同目录的 `.credentials.yaml` 一个量级，单人机器可接受）。密码不回传浏览器，列表里只有 `hasPassword`。

**也可以写进 profile patch**，插件第一次启动时当种子用（文件已有内容就不覆盖）：

```yaml
- id: smb-picker
  config:
    connections:
      - label: 生图机
        host: 192.168.1.10
        share: gallery
        username: Administrator
        password: "..."
        path: outputs
```

## 面板怎么用

- 点格子 = 选中／取消，右上角打勾
- 双击图片 = 全屏预览
- 面包屑逐级回退，左上角箭头上一级
- 「只看图片」过滤掉非图条目；搜索框按名字现筛（只筛当前目录，不递归）
- 「加入对话」把选中的全部塞进草稿，仍是**全或无**：有一个取不回来就整批不添加，报名字给你重试

## 路由

四条精确 Fetch 路由，挂在 Connection 已认证的 `/api` 通道上，Host/Origin 围栏与浏览器认证由 Connection 先做，路由本身不再自建鉴权：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/smb-picker.connections` | GET / POST | 连接表：列出、保存并测试、删除 |
| `/api/smb-picker.shares` | GET | 枚举共享名，配连接时参考 |
| `/api/smb-picker.list` | GET | 列一层目录 |
| `/api/smb-picker.raw` | GET | 流式取一个文件字节 |

拒绝 `..`、NUL、控制字符；目录条目上限 4000；空闲 5 分钟的 SMB 会话自动关闭，改凭据会立刻拆掉旧会话。

## 已知边界

- 图片附件只认 `png / jpeg / webp / gif`（DSH 的准入白名单）。`bmp / avif / svg` 会被当成普通文件进去 —— 能发，但模型看不到图。
- 没做服务端缩略图：网格直接用原图，靠 `IntersectionObserver` 懒加载。目录里几千张图时首次滚动会有明显延迟。
- 只读。不写、不删、不重命名共享里的东西。
- 需要 SMB2/3 且服务器允许 NTLMv2（Windows 默认允许；被组策略关掉就要另想办法）。
- 每次列目录 / 取文件都会新起一个 Python 进程并重新认证一次，所以首屏大约 0.7 秒起。真正的痛点是共享里文件特别多时缩略图加载会排队（浏览器对同源并发有上限）。
- 不支持 Kerberos、DFS、NetBIOS over TCP/139。
