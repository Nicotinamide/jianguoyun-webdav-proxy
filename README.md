# jianguoyun-webdav-proxy

基于 **Cloudflare Workers** 的坚果云 WebDAV 反向代理。

## 特性

- 完整支持 WebDAV 标准动词（`PROPFIND`, `MKCOL`, `MOVE`, `COPY`, `DELETE`, `PUT`, `GET`, `OPTIONS` 等）。
- 自动重写 `Host` 与 `Origin` 头，保证坚果云鉴权和 SNI 校验通过。
- **自动改写 `Destination` 头**：解决文件/文件夹移动（`MOVE`）与复制（`COPY`）时的跨域报错问题。
- **自动改写 `Location` 重定向头**：防止客户端被重定向回坚果云原生域名。
- 支持 GitHub Actions 自动化 CI/CD 部署。

---

## 快速推送到 GitHub

1. 在 GitHub 上新建一个空白仓库（例如命名为 `jianguoyun-webdav-proxy`）。
2. 在本项目根目录下执行以下命令推送代码：

```bash
git remote add origin https://github.com/<你的GitHub用户名>/jianguoyun-webdav-proxy.git
git branch -M main
git push -u origin main
```

---

## 部署方式（二选一）

### 方式一：Cloudflare 仪表盘直接关联 GitHub（最简单，推荐）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 进入 **Compute (Workers & Pages)** -> **Overview** -> 点击 **Create Application**。
3. 选择 **Workers** -> 点击 **Connect to Git**（连接到 Git 仓库）。
4. 授权 GitHub 并选择刚才创建的 `jianguoyun-webdav-proxy` 仓库。
5. 部署设置默认即可，点击 **Save and Deploy**。
6. 以后每次推送代码到 `main` 分支，Cloudflare 都会自动完成重新部署。

---

### 方式二：使用 GitHub Actions 自动部署

本项目已内置 `.github/workflows/deploy.yml`。

1. 在 Cloudflare 控制台获取 API Token：
   - 进入 **My Profile** -> **API Tokens** -> **Create Token**。
   - 选择 **Edit Cloudflare Workers** 模板。
   - 创建后复制 Token。
2. 获取 Account ID：
   - 在 Cloudflare 控制台右侧侧边栏或 Workers 页面即可看到 **Account ID**。
3. 在 GitHub 仓库设置中添加 Secrets：
   - 打开 GitHub 仓库 -> **Settings** -> **Secrets and variables** -> **Actions**。
   - 点击 **New repository secret**，分别添加：
     - `CLOUDFLARE_API_TOKEN`: 刚才生成的 Token
     - `CLOUDFLARE_ACCOUNT_ID`: 你的 Account ID
4. 之后只要 `git push` 到 `main` 分支，GitHub Actions 就会自动将代码部署到 Cloudflare Workers。

---

### 方式三：本地通过 Wrangler CLI 部署

```bash
# 登录 Cloudflare
npx wrangler login

# 部署
npm run deploy
```

---

## 客户端配置示例

在 Obsidian、Zotero、Joplin、KeePass 等支持 WebDAV 的客户端中配置：

- **WebDAV 服务器地址**：`https://<你的Worker域名或自定义域名>/dav/`
- **用户名**：坚果云注册邮箱
- **密码**：坚果云账号设置中生成的**第三方应用专用密码**（非网页登录密码）

---

## 注意事项

1. **自定义域名推荐**：建议在 Cloudflare Worker 的 **Triggers** -> **Custom Domains** 绑定自己的域名（例如 `dav.yourdomain.com`），以避免 `*.workers.dev` 域名在部分网络环境下受限。
2. **免费版 100MB 上传限制**：Cloudflare 免费版对请求体大小限制为 100MB。常规笔记、文献库、密码库同步完全足够，但不建议用于同步大体积视频或超大压缩包。
3. **Cloudflare WAF 防火墙**：若客户端同步报错 403，请在 Cloudflare 域名的 **Security** -> **WAF** 中，为该域名或 `/dav/*` 路径配置一条跳过（Skip）安全检查的规则。
