# 主题

本目录是**项目内主题**的约定位置：设置 → 主题 → 本地主题 会自动探测 `<项目>/themes/<名字>/`（以及 `<项目>/.pi/themes/<名字>/`），列出后可直接应用或导入到数据目录。以 `_` 开头的目录会被跳过，因此 `_template/` 不会出现在列表里。

- `_template/` —— 第三方主题的起点。
- `slate/` —— 一个可直接应用的示例主题（深色基底 + 浅色变体），也可以作为项目内主题的样板。
- `pi-web-theme-nier/` —— 实际使用的项目内主题示例（NieR 风格，浅/深双变体 + 双光标），演示「放进 `themes/` 就能被探测到」。

`_template/` 是第三方 Pi Web 主题的起点。把它复制到本仓库之外（主题是独立的项目），修改 `theme.json` 与 `theme.css`，然后在设置面板的「主题」分区里指向它：

- 开发期间使用 `local:/absolute/path/to/my-theme` —— 文件每次请求都从磁盘读取，改完刷新即可生效；
- 要分享时推到 GitHub，并使用
  `https://github.com/you/pi-web-theme-my-theme/tree/main`（也可以用 commit sha，会按不可变缓存）。

完整的契约见 [../docs/theme-development.md](../docs/theme-development.md)。
