# 发布给其他部署者

发布项目时使用 `scripts/package-selfhost.py` 生成的干净源码目录和压缩包。不要直接上传开发主机的整个工作目录，其中可能包含日志、身份信息、凭据、上游二进制和现场调查材料。

```sh
python3 scripts/package-selfhost.py
```

产物位于 `dist/`：源码目录、ZIP、tar.gz、SHA256SUMS。打包采用文件白名单，包内的 `SOURCE_MANIFEST.json` 记录各源文件 SHA-256。再次打包前需另存旧产物或更新脚本版本号。只把干净源码目录作为 Git 仓库根目录；在开发者的原始工作目录里执行 `git add .` 不安全。

在 GitHub 创建空仓库，例如 `teamspeak-sfu`。然后在生成的干净源码目录执行以下命令，将 `OWNER` 改为自己的 GitHub 用户或组织：

```sh
git init -b main
git add .
git diff --cached --stat
git commit -m "Release native SFU self-host preview"
git remote add origin git@github.com:OWNER/teamspeak-sfu.git
git push -u origin main
```

GitHub → Releases → Draft a new release，标签使用 `v0.1.0-preview.1`，说明使用 `RELEASE_NOTES.md`，勾选 **This is a pre-release**，附件上传 ZIP、tar.gz 和 SHA256SUMS。核对后发布，再把仓库链接和 `docs/SELFHOST.md` 链接发给使用者。也可以先保存为草稿。参见 [GitHub 官方发布说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

项目介绍应保留这段限制：

> 支持原版 TeamSpeak 6 beta4.1 客户端通过自行部署的实验服务端共享屏幕。画面已验证，共享声音暂不可用。首版仅支持 Linux ARM64 及固定服务端版本，适合愿意反馈问题的测试者。

后续贡献优先事项：官方共享声音与音量控件、x86_64 服务端适配、异常退出恢复、安装兼容性、长时间运行验证。提交问题时说明服务器架构、系统、客户端完整版本、发布者/观看者角色和复现步骤。日志应先移除密码、权限密钥、token、用户 UID 和个人地址，不上传整个客户端安装目录。
