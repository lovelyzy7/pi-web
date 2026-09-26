# 发布检查清单

本仓库每次发布两个产物：

- npm 包：`@agegr/pi-web`
- GitHub Release：`lovelyzy7/pi-web`

请在干净的 `main` 检出目录里按此清单执行。

## 0. Fork 上的一次性设置（CI 与 Demo 失败多半是这两条）

本仓库是 `agegr/pi-web` 的 fork，GitHub 对 fork 有两个默认关闭的开关。**它们不是工作流文件的问题**：工作流“失败”或干脆不出现，通常就是因为在设置里没打开。

1. **启用 Actions**（fork 默认禁用，所以 `/actions/workflows` 是空的、也没有任何运行记录）
   仓库 → **Settings → Actions → General → Actions permissions** 选 *Allow all actions and reusable workflows* → Save；
   或打开 **Actions** 标签页，点横幅里的 *I understand my workflows, go ahead and enable them*。
2. **启用 Pages**（Demo 工作流的部署步骤需要）
   仓库 → **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
   也可以不做：工作流里的 `actions/configure-pages@v5` 带 `enablement: true`，第一次运行会自动创建 Pages 站点、把源设为 GitHub Actions（需要 `pages: write`，文件里已经给了）。

确认状态：

```bash
curl -s https://api.github.com/repos/lovelyzy7/pi-web/actions/workflows | jq '{total: .total_count, state: [.workflows[].state]}'
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/lovelyzy7/pi-web/pages   # 200 = 已启用
```

启用后 `CI`（lint / 类型检查 / 单元测试 + 构建后的浏览器回归）与 `Demo`（静态演示 → GitHub Pages）都应转绿。两个工作流的内容与上游相同，只有仓库链接指向本 fork。

### npm 包名仍是 `@agegr/pi-web`

仓库链接已改成本 fork，但 **npm 包名没有改**：`@agegr` 是上游的 scope，要改名得把它发布到自己的 scope（例如 `@lovelyzy7/pi-web`），并同步这些位置：`package.json` 的 `name`、`lib/self-update.ts` 里的安装目标、`lib/app-update-service.ts` 的升级提示、README 的 `npx …` 说明、`AGENTS.md` 的容器内更新一节。
**不要改** `lib/session-liveness.ts` 里的 `Symbol.for("@agegr/pi-web/session-liveness/v1")` —— 那是 globalThis 上的跨模块键，改名会让新旧模块互不认识。不发布自己的包时保持现状即可（`npx @agegr/pi-web@latest` 装的仍是上游包，Docker 镜像则从本仓库源码构建）。

## 1. 发布前确认

```bash
git status --short --branch
git log --oneline --decorate -5
gh auth status
npm whoami
node -e "const p=require('./package.json'); console.log(p.version)"
```

预期：

- `git status` 干净，或只包含你确实打算发布的改动。
- GitHub 已用有推送与创建 release 权限的账号登录。
- npm 已用有 `@agegr/pi-web` 发布权限的账号登录。

## 2. 发布到 npm

```bash
npm run release
```

发布脚本会执行：

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

说明：

- 它会同时更新 `package.json` 与 `package-lock.json`。
- 它刻意执行生产构建。日常开发不要运行 `next build`，发布是例外。
- 如果 `npm view @agegr/pi-web version` 短暂显示旧版本，请直接查确切版本：

```bash
npm view @agegr/pi-web@<version> version --registry https://registry.npmjs.org/
npm view @agegr/pi-web versions --json --registry https://registry.npmjs.org/
```

## 3. 提交版本号变更

把 `<version>` 换成新的包版本，例如 `0.7.5`。

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. 打标签并推送

```bash
git tag -a v<version> -m "v<version>"
git push origin main --tags
```

不确定标签是否已存在时，先确认再创建：

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo lovelyzy7/pi-web
```

## 5. 从提交记录生成发布说明

以上一次发布的标签为基准。

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

发布说明要依据这些提交来写，而不是凭记忆。同时包含中文与英文两部分；必要时在每条后面附上提交哈希。

建议结构：

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `@agegr/pi-web@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `@agegr/pi-web@<version>`.
```

## 6. 创建或更新 GitHub Release

创建新的 release：

```bash
gh release create v<version> \
  --repo lovelyzy7/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file release-notes.md
```

如果 release 已存在、只需更新说明：

```bash
gh release edit v<version> \
  --repo lovelyzy7/pi-web \
  --notes-file release-notes.md
```

也可以用 stdin 传入说明，避免临时文件：

```bash
gh release edit v<version> --repo lovelyzy7/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. 最终核对

```bash
gh release view v<version> --repo lovelyzy7/pi-web
npm view @agegr/pi-web@<version> version --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
```

预期：

- GitHub Release 存在；除非有意发布为草稿，否则不是 draft。
- npm 上的确切版本可以查询到。
- `main` 与 `origin/main` 一致。
- `HEAD` 指向发布提交，且存在 `v<version>` 标签。
