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
| 列目录、`stat`、缩略图 | `smbprotocol`，**常驻会话**（`lib/smb_daemon.py`） |
| 取原图字节 | `smbprotocol`，一次性进程（`lib/smb_worker.py`） |

为什么分两种：常驻会话认证一次就反复用，把每张缩略图从 1.1 秒压到 0.14 秒；但原图动辄几兆，走常驻通道会把整个会话堵住，所以流式读原图单独开进程，用完即走。

凭据通过 **stdin** 传给子进程，不进 argv、不进环境变量，`ps` 和 `/proc/<pid>/environ` 都读不到密码。

## 性能

网格里**从不加载原图**。每格先请求 `/api/smb-picker.thumb?w=400`，服务端解码后出 400px 的 WebP；点开预览走 `w=1200`；只有真正「加入对话」时才取原图。

实测（同一张 907 KB 的 PNG，走局域网 SMB）：

| | 之前 | 现在 |
|---|---|---|
| 一张图的体积 | 907 KB | **5 KB** 左右 |
| 8 张缩略图（首次） | ~8.8 s | **1.3 s** |
| 8 张缩略图（二次） | — | **0.17 s**（磁盘缓存，不碰 SMB） |
| 列一层目录 | 0.72 s | 0.11 s（会话已热） |

缩略图落在 `~/.dsh/cache/smb-thumbs/`，按「连接 + 路径 + 宽度」哈希命名，24 小时过期，超过 2000 个自动裁到 1500 个。因为缓存键不含文件大小，同名文件被覆盖后**最多一天内看到旧缩略图**，点开原图是对的。

会话空闲 5 分钟自动关闭；进程被杀或被 OOM 后，下一个请求会自己重启并重试一次，不会把错误抛给人看。

## 安装

```bash
cd <这个目录>
npm install

# Linux / macOS
python3 -m venv .venv && .venv/bin/pip install smbprotocol Pillow

# Windows（PowerShell 或 cmd）
python -m venv .venv && .venv\Scripts\pip install smbprotocol Pillow
```

要 Python ≥ 3.9，且该 Python 带 `venv` 模块（Debian/Ubuntu 需另装 `python3-venv`；部分便携版 Python 去掉了 `venv`，会报 `No module named venv`，换一个完整安装即可）。`.venv` 就在插件目录里，跟着插件走。

解释器路径**按平台自动识别**：Windows 先找 `.venv\Scripts\python.exe`，Linux/macOS 先找 `.venv/bin/python`，两边都会回退到对方的布局，所以手动建错位置也能跑。找不到时错误信息会列出**尝试过的全部路径**，并给出当前平台该执行的建 venv 命令。

然后把它挂进 profile —— 二选一：

```bash
# A. 从 GitHub 装（快照，改了要先 push 再重装）
dsh plugin --profile web add github:c225820h/DeepSeek_Harness-SMB

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

- 排序：**目录在前，同类按修改时间倒序**，最新的在最上面；格子名字下面是相对时间（「刚刚」「3 小时前」「11-24」），悬停可看完整时间
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
- 缩略图走常驻会话但**串行处理**：SMB 单会话本来也只能排队，所以一屏 12 张是排着出的（约 1.7 秒），不是并发。
- 取原图仍然每张新起一个进程（约 0.85 秒），因为它不能堵住常驻会话。
- 不支持 Kerberos、DFS、NetBIOS over TCP/139。
