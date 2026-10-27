# 发布到 GitHub

本机原本没有 `git`，现在已把 PortableGit 解压到 `D:\Tools\git-portable\PortableGit`（免管理员），下面以命令行推送为主，网页上传留作备选。

## 0. 仓库地址

已固定为 <https://github.com/jingciling/dsh-token->。`package.json` 的 `repository` / `bugs` / `homepage` 和 README 里的 `github:` 安装示例都已指向它，无需再替换占位符。

## 1. 建仓库

打开 <https://github.com/new>：

- **Repository name**: `dsh-token-budget`
- **Visibility**: Public
- **不要**勾 "Add a README file" / ".gitignore" / "license" —— 本地已经有 `README.md`、`.gitignore`、`LICENSE`，勾了会产生冲突。

## 2. 上传文件

新仓库页面点 **uploading an existing file**（或 `Add file → Upload files`），把整个 `dsh-token-budget` 文件夹的**内容**拖进去。

```
.github/workflows/ci.yml
.gitignore
LICENSE
README.md
client.js
cordis.patch.yml
icon.svg
index.js
locale/en.json
locale/zh.json
package.json
test/gate.test.mjs
```

注意事项：

- 拖的是**文件夹里的内容**，不是文件夹本身；拖文件夹 GitHub 会保留里面的目录结构。
- 先在资源管理器里打开「显示隐藏的项目」，否则 `.github`、`.gitignore` 这类点开头的条目容易被漏掉。
- 网页上传单批上限 100 个文件 / 单个 25 MB，这个包只有 13 个文件，一次就够。
- commit message 写 `feat: daily token budget guard for DSH` 之类即可，直接提交到 `main`。

## 3. 提交后补两件小事

- 仓库右侧 **About** 齿轮 → 填一句描述，加 topics：`dsh`、`deepseek-harness`、`cordis`、`token-budget`、`plugin`。
- 点 **Releases → Draft a new release**，tag 打 `v0.1.0`，标题「首个版本」。别人之后可以用 `github:USER/dsh-token-budget#v0.1.0` 锁版本。

## 4. 之后怎么在别的机器上装

```
plugin_manager install_bundle  target="github:jingciling/dsh-token-"
```

或者手动：

```powershell
cd $HOME\.dsh\profiles\<profile>
pnpm add github:jingciling/dsh-token-
# 再把 "@local/dsh-token-budget" 加进该 profile package.json 的 dsh.profile.bundles
```

## 5. 以后改了代码怎么同步

网页上传不适合反复改。建议二选一：

- **GitHub Desktop**（装完自带 Git，有图形界面、自带登录），clone 到本地后每次改完点 Commit → Push。
- **命令行 Git**：见下。

### 命令行版本（装 Git 之后）

```powershell
winget install --id Git.Git -e --source winget

cd <本仓库所在目录>
git init -b main
git add -A
git commit -m "feat: daily token budget guard for DSH"
git remote add origin https://github.com/jingciling/dsh-token-.git
git push -u origin main
```

第一次 push 会弹出 GitHub 登录（Git Credential Manager 浏览器授权一次即可）。如果仓库是用网页先建的、里面已经有文件，改用：

```powershell
git pull --rebase origin main
git push -u origin main
```

## 不该进仓库的东西

已经用 `.gitignore` 挡住了，确认一下：

- `node_modules/`（本机是 junction 链接，不能传）
- 账本 `%USERPROFILE%\.dsh\token-budget\ledger.json`（运行期数据，本来就不在包目录里）
- `*.log`、`.env`

## 一个待办

`package.json` 里 `name` 仍是 `@local/dsh-token-budget`、`private: true`。这不妨碍从 GitHub 安装，但如果你想发到 npm，需要改成不带 `@local` 的名字并把 `private` 去掉——届时 `client.js` 里 `__ModuleLoader__.load({ id: ... })` 的 id 必须跟着改成同一个名字。
