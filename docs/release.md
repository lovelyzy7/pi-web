# 发布检查清单

本仓库每次发布两个产物：

- npm 包：`@agegr/pi-web`
- GitHub Release：`agegr/pi-web`

请在干净的 `main` 检出目录里按此清单执行。

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
gh release view v<version> --repo agegr/pi-web
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
  --repo agegr/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file release-notes.md
```

如果 release 已存在、只需更新说明：

```bash
gh release edit v<version> \
  --repo agegr/pi-web \
  --notes-file release-notes.md
```

也可以用 stdin 传入说明，避免临时文件：

```bash
gh release edit v<version> --repo agegr/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. 最终核对

```bash
gh release view v<version> --repo agegr/pi-web
npm view @agegr/pi-web@<version> version --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
```

预期：

- GitHub Release 存在；除非有意发布为草稿，否则不是 draft。
- npm 上的确切版本可以查询到。
- `main` 与 `origin/main` 一致。
- `HEAD` 指向发布提交，且存在 `v<version>` 标签。
