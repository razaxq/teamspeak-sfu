# 自行部署实验版 SFU

[English](SELFHOST.md) | **简体中文**

建议具备软件开发经验，或熟悉使用 **Codex** 辅助开发、部署和排错的人操作本项目。需要能够配置 Linux 网络、检查诊断信息，并在自己的服务器上验证改动。

这是 **v0.1.0-preview.3**。原版 TeamSpeak 6 客户端之间的共享画面已由实际用户确认；**共享声音不可用，观看端没有共享音量控件**。正常语音聊天与共享声音是不同功能。浏览器音视频测试通过不代表官方客户端共享声音可用。

目前仅支持 **Linux ARM64 / aarch64**，使用固定版本的 TeamSpeak 服务端镜像。已验证的官方 Windows 客户端为 **6.0.0-beta4.1，内部版本号 1779880475**。没有验证 x86_64 服务端、其他客户端版本、大规模房间或长期无人值守运行。

该部署会建立一个独立 TeamSpeak 实验服务端，并加载本项目的服务端扩展。**仅给已有的普通 TeamSpeak 服务端填写 SFU Endpoint，不能获得相同功能。** 客户端保持原版。扩展依赖固定二进制布局，启动前校验 SHA-256；不要自动升级服务端镜像。

## 准备服务器

准备有公网 IPv4 的 ARM64 Linux 服务器、root 权限、systemd、rootful Podman、iptables、GCC 和 Node.js 22 或更新版本。当前脚本使用 IPv4、直接 WebSocket 连接和 Podman 默认桥接网络；不提供反向代理、WSS、TURN、IPv6 或 rootless 部署方案。

以下安装命令适用于 Debian / Ubuntu 系统，其他发行版请安装对应的软件包。Node.js 需要自行安装到系统 PATH（例如 `/usr/bin/node` 或 `/usr/local/bin/node`），不要仅装在某个用户的 nvm 环境中。

```sh
sudo apt-get update
sudo apt-get install -y podman iptables build-essential python3 python3-pip ca-certificates
uname -m
node --version
```

`uname -m` 必须显示 `aarch64`。依赖安装会下载 mediasoup worker，无法下载时会尝试本地编译，需要 Python 3.10+、pip 和 C++ 编译器；参见 [mediasoup 安装说明](https://mediasoup.org/documentation/v3/mediasoup/installation/)。

把源码包解压到 `/opt/ts6-native-sfu-lab`，确认该目录直接包含 `media/`、`deploy/`、`scripts/`。以下命令以 root 执行：

```sh
mkdir -p /opt/ts6-native-sfu-lab
tar -xzf ts6-native-sfu-lab-v0.1.0-preview.3.tar.gz --strip-components=1 -C /opt/ts6-native-sfu-lab
cd /opt/ts6-native-sfu-lab
npm --prefix media ci --omit=dev
install -m 600 deploy/selfhost.env.example /etc/ts6-sfu-selfhost.env
```

编辑 `/etc/ts6-sfu-selfhost.env`：将 `SFU_PUBLIC_HOST` 换成自己的域名或公网 IPv4；域名 A 记录必须直接解析到这台服务器，关闭 CDN 代理。只填写主机名，不带 `http://`、端口或路径。阅读 TeamSpeak 服务端许可条款后，将 `TSSERVER_LICENSE_ACCEPTED` 设置为 `accept`。其余项目可以保留默认值。

拉取固定镜像：

```sh
podman pull docker.io/teamspeaksystems/teamspeak6-server@sha256:a89b53db7b4a213251a47b652b212d1314728ec8c498f5246cf7e7622587ed89
node --env-file=/etc/ts6-sfu-selfhost.env media/scripts/selfhost.js --check
```

检查命令会创建并删除一个未启动的临时容器，验证服务端二进制，然后编译本项目扩展，不会启动语音服务器。预期输出 `preflight: passed`。官方程序由部署者从上游拉取，本项目源码包不包含 TeamSpeak 可执行文件或客户端 DLL。

## 开放端口并启动

在云安全组及上游防火墙开放以下端口，改过配置时使用相应的新端口：

| 默认端口 | 协议 | 用途 |
| --- | --- | --- |
| 19987 | UDP | TeamSpeak 连接和语音 |
| 18344 | TCP | 原生 SFU WebSocket 信令 |
| 19125 | UDP、TCP | WebRTC 媒体 |
| 11022 | TCP，仅回环 | 内部 SSH Query，不向公网开放 |

脚本会插入本实例所需的宿主机 iptables 规则，正常停止时删除这些规则；不会修改云安全组。已有严格网络策略的主机需要管理员检查规则是否匹配自身要求。客户端不需要公网地址。

```sh
install -m 644 deploy/ts6-sfu-selfhost.service /etc/systemd/system/ts6-sfu-selfhost.service
systemctl daemon-reload
systemctl enable --now ts6-sfu-selfhost
systemctl status ts6-sfu-selfhost --no-pager
cat /var/lib/ts6-sfu-selfhost/status.json
```

首次启动需要数十秒。`status.json` 中 `ready` 和 `viewerDiscoveryReady` 都为 `true` 后，查看本机凭据：

```sh
cat /var/lib/ts6-sfu-selfhost/access.txt
```

此文件包含服务器密码和一次性管理员权限密钥，权限为 `0600`。它只应提供给部署者；普通使用者只需要服务器地址与连接密码。不要把此文件、`server.env`、整个状态目录或未经审阅的日志上传到公开仓库。

## 使用官方客户端

1. 发布者和观看者连接 `公网IPv4:19987`，输入生成的服务器密码。显式写出端口，避免域名 SRV 记录跳转到别的服务器。
2. 已连接的普通用户无需管理员权限即可开播。`access.txt` 中的管理员权限密钥仅用于管理服务器，不要为了共享屏幕而授予管理员权限。
3. 双方进入同一频道。发布者打开屏幕共享，选择 Server / 服务器，再开始直播。
4. 观看者从正在分享的图标进入观看；需要时由发布者允许加入。

SFU Endpoint 由脚本自动设置为 `SFU_PUBLIC_HOST:SFU_WS_PORT`。频道中会出现名为“SFU 服务”的连接，用于原生分享通知，不要踢出。原生 SFU 不再设置固定的总连接数/房间数配额，`viewer_limit=0` 也不再被改成 16。正数的单路直播观看人数设置仍然生效。TeamSpeak 自身的槽位配置及许可上限仍有效；[官方 Beta 许可提供 32 个槽位](https://github.com/teamspeak/teamspeak6-server#readme)，通知服务占用其中一个。每个 TeamSpeak 连接单路直播以及单次请求的协议保护仍保留，不宣称已具备大规模承载能力。

凭据现在随连接有效，不再一小时到期；断线、换频道、凭据轮换或 Query 失联仍撤销访问。`SFU_TS_MAXCLIENTS=0`（默认值）表示保留 TeamSpeak 自身的槽位设置。从旧版生成的实例升级且仍为 8 槽时，启动脚本会一次性迁移到 32，并在状态目录记录迁移；之后通过 TeamSpeak 修改的槽位数会被保留。设置正数 `SFU_TS_MAXCLIENTS` 会在启动时明确指定槽位数，仍受 TeamSpeak 自身限制，并不代表无限槽位。

## 维护与排错

```sh
systemctl stop ts6-sfu-selfhost
systemctl start ts6-sfu-selfhost
```

TeamSpeak 数据保存在 Podman 卷 `ts6-sfu-selfhost-data`；密码和扩展状态保存在 `/var/lib/ts6-sfu-selfhost/`。两者应一同备份。正常重启复用数据与密码，不再生成新的管理员密钥；旧密钥使用后仍会显示在文件中，但无法重复使用。不要删除数据卷来排查连接故障。

若服务显示运行但尚未就绪，先检查 `status.json`；再在本机查看 `journalctl -u ts6-sfu-selfhost -n 50 --no-pager`。不要公开原始容器启动日志，其中可能有权限密钥。

- `Unsupported ...`：架构或服务端镜像不匹配，请使用文档固定镜像。
- `Deployment command failed`：检查系统依赖、镜像是否已拉取、端口和目录权限。
- 容器已经存在：脚本不会接管同名容器。先核实它是否是本项目异常退出留下的容器，停止对应服务后再处理；不要删除未知容器。
- 无共享入口：确认客户端连接的是已更新的实验服务器，重新连接、进入同一频道，并检查 `viewerDiscoveryReady`。
- 能连接语音但不能观看：检查 18344/TCP、19125/UDP/TCP 和域名 A 记录。当前没有 TURN 中继。
- 能看画面但没有共享声音和音量控件：这是此版本已知限制。

卸载服务时先 `systemctl disable --now ts6-sfu-selfhost`，移除 unit 并执行 `systemctl daemon-reload`。数据卷和状态目录默认保留。非正常断电或强制杀进程可能留下容器或带实例名称注释的 iptables 规则，需要人工核实后清理。

## 开发验证

```sh
cd /opt/ts6-native-sfu-lab/media
npm ci
npm test
```

测试覆盖鉴权、权限撤销、原生消息、观看审批、媒体资源清理和部署配置校验。可选的浏览器测试需要额外安装 Playwright Chromium，并构建网页资源；它们不能替代两个官方客户端之间的实际验收。

## 从 preview.1 或 preview.2 升级

停止本项目的 systemd 服务，用 preview.3 源码更新程序目录，重新执行 `npm --prefix media ci --omit=dev` 和预检查，然后启动服务。保留 `/etc/ts6-sfu-selfhost.env`、状态目录和 Podman 数据卷。客户端重新连接后即可使用新策略，无需兑换管理员密钥。
