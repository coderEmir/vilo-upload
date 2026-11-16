# Vilo 模板管理平台

基于 Vue 3 和 Vite 的模板运营后台，提供模板管理与主体批量替换两个工作区。主体替换结果先进入候选区，人工预览、选择后再写入正式模板库，入库时复用后端模板校验和持久化服务。

## 服务与接口

| 功能 | 服务名称 | 默认端口 | 浏览器请求前缀 | 后端路径前缀 |
| --- | --- | --- | --- | --- |
| 模板管理 | `vilo-template` | 3010 | `/template-api` | `/api` |
| 主体批量替换 | `vilo-template-remix-api` | 3020 | `/remix-api` | `/api` |
| 主体替换任务执行 | `vilo-template-remix-worker` | 无 HTTP 端口 | 无 | 无 |

模板管理主要接口为 `GET/POST /api/templates` 和 `PATCH/DELETE /api/templates/:id`。主体替换配置接口为 `GET /api/template-remix/config`，成功响应包含 `models` 数组。

API 服务与任务进程可以分别发布和重启。以下 PM2 命令均在 `vilo-backend` 目录执行：

```bash
pm2 start ecosystem.config.js --only vilo-template --env production
pm2 start ecosystem.config.js --only vilo-template-remix-api --env production
pm2 start ecosystem.config.js --only vilo-template-remix-worker --env production
```

## 本地开发

1. 在后端环境中配置至少 32 个字符的 `TEMPLATE_ADMIN_API_KEY`，启动 3010 模板服务、3020 主体替换服务；执行生成任务还需要启动主体替换任务进程。
2. 在本 README 所在目录（`Vilo/vilo-upload/vilo-upload`）执行：

   ```bash
   cp .env.example .env
   npm ci
   npm run dev
   ```

3. 默认保留以下配置：

   ```dotenv
   VITE_API_BASE=/template-api
   VITE_REMIX_API_BASE=/remix-api
   ```

   Vite 开发服务器会将 `/template-api/*` 转发至 `http://127.0.0.1:3010/api/*`，将 `/remix-api/*` 转发至 `http://127.0.0.1:3020/api/*`。修改 `vite.config.ts` 后需要重启开发服务器。后端地址不同时，可按 `.env.example` 设置直接访问地址，并确保后端允许对应跨域来源。

4. 在页面页脚输入管理密钥，点击“验证并保存”。两个服务验证成功后，密钥存入浏览器本地存储。

## 首次生产部署

准备 Node.js 20 及以上版本、Nginx、PM2，以及指向服务器的 `upload.viloai.fun` 域名解析。两个 API 服务应可通过 `127.0.0.1:3010` 和 `127.0.0.1:3020` 访问。

### 配置并启动后端

在 `/etc/vilo/backend.env`（推荐）或 `vilo-backend/.env` 配置后端环境。可以通过 `openssl rand -base64 48` 生成管理密钥，将其设为 `TEMPLATE_ADMIN_API_KEY`。两个 API 服务必须使用相同密钥；密钥不得写入任何 `VITE_*` 变量或前端构建产物。

以下 `/path/to/Vilo` 均替换为服务器上的实际仓库路径：

```bash
cd /path/to/Vilo/vilo-backend
npm ci
ENV_FILE=/etc/vilo/backend.env npm run check:config -- --no-connect
ENV_FILE=/etc/vilo/backend.env node scripts/prisma.mjs remote generate
ENV_FILE=/etc/vilo/backend.env node scripts/migrate-all.mjs --target remote --skip-seed
npm run build
ENV_FILE=/etc/vilo/backend.env pm2 startOrReload ecosystem.config.js --only vilo-template,vilo-template-remix-api,vilo-template-remix-worker --env production --update-env
pm2 save
```

数据库迁移属于首次部署或存在待执行迁移时的步骤；本次前端异常修复无需数据库迁移。

### 发布管理页面

在包含 `package.json`、`scripts` 和 `deploy` 的内层目录执行。发布脚本需要对 `/var/www` 下的发布目录和备份目录有写权限，以下使用 `sudo` 执行；服务器需确保该环境可找到 Node.js 和 npm。

```bash
cd /path/to/Vilo/vilo-upload/vilo-upload
sudo env VITE_API_BASE=/template-api VITE_REMIX_API_BASE=/remix-api WEB_ROOT=/var/www/vilo-upload bash ./scripts/deploy.sh
```

脚本先执行 `npm ci` 和完整 `npm run build`，成功后才替换线上静态目录，上一版本保存在 `/var/www/vilo-upload.previous`。构建失败时不会替换线上目录。API 地址在构建时写入产物，修改后必须重新构建发布。

### 配置生产代理与 HTTPS

生产静态页面由 Nginx 提供，Vite 开发代理不会进入生产构建。Nginx 必须分别配置两个 API 前缀，否则请求可能被页面回退规则处理，返回 HTTP 200 和 HTML 页面。

首次安装 HTTP 站点配置：

```bash
cd /path/to/Vilo/vilo-upload/vilo-upload
sudo cp deploy/nginx-upload.viloai.fun.conf /etc/nginx/sites-available/upload.viloai.fun.conf
sudo ln -sfn /etc/nginx/sites-available/upload.viloai.fun.conf /etc/nginx/sites-enabled/upload.viloai.fun.conf
sudo nginx -t && sudo systemctl reload nginx
```

为域名申请并安装 TLS 证书。确认 `/etc/letsencrypt/live/upload.viloai.fun/` 中已有证书后，可执行修复脚本，备份并重写该站点的 HTTP 跳转及 HTTPS 配置：

```bash
sudo bash ./scripts/check-fix-upload-nginx.sh --fix
```

脚本会校验 Nginx 配置并重新加载；校验失败时尝试恢复原配置。若站点包含自定义规则，执行前应审阅脚本生成的配置。只检查、不改配置时执行：

```bash
sudo bash ./scripts/check-fix-upload-nginx.sh
```

关键转发关系如下，`proxy_pass` 末尾的 `/api/` 用于替换请求前缀：

```nginx
location /template-api/ {
    proxy_pass http://127.0.0.1:3010/api/;
}

location /remix-api/ {
    proxy_pass http://127.0.0.1:3020/api/;
}
```

完整超时、请求头和上传大小配置见 `deploy/nginx-upload.viloai.fun.conf` 及修复脚本。上传大小上限为 500 MB。

## 本次 models 空响应异常修复的部署

原报错为 `Cannot read properties of null (reading 'models')`。前端此前将 JSON 解析失败转换为 `null`，随后直接读取 `data.models`，因此 HTML 页面、空响应或 JSON `null` 都可能触发该异常。代理缺失导致请求落入页面回退规则是需要检查的原因之一。

本次改动包括：

- 主体替换请求统一检查响应，拒绝非 JSON 对象，并保留后端错误信息或 HTTP 状态。
- 配置接口必须包含 `models` 数组，素材上传响应必须包含有效的 `url` 和 `mimeType`。
- 密钥验证必须返回有效 JSON 且 `valid` 为 `true`，避免把 HTTP 200 的 HTML 页面误判为验证成功。
- 本地 Vite 增加 3010、3020 两个独立 API 代理。

已有生产环境按以下顺序更新：

1. 更新本次前端源码，按“发布管理页面”中的命令重新构建发布。仅更新静态页面即可应用响应校验；本次改动无需重启后端或执行数据库迁移。
2. 检查现有 HTTPS 站点是否包含 `/remix-api/` 代理，并确认它转发至 `127.0.0.1:3020/api/`。若缺失，补齐后执行 `sudo nginx -t && sudo systemctl reload nginx`；也可在证书已存在且确认可重写站点时使用上述 `--fix` 脚本。
3. 检查服务与代理链路：

   ```bash
   curl -i http://127.0.0.1:3010/health
   curl -i http://127.0.0.1:3020/health
   curl -i https://upload.viloai.fun/template-health
   curl -i https://upload.viloai.fun/remix-health
   curl -i https://upload.viloai.fun/remix-api/template-remix/config
   ```

   健康接口应返回 JSON。最后一条未携带管理密钥，正常配置下应返回鉴权错误 JSON；若返回 HTTP 200 和 HTML，则 API 请求仍落入静态页面，应继续修复代理。若返回 502，应检查 3020 服务及上游地址。
4. 浏览器强制刷新页面，在页脚重新“验证并保存”管理密钥，进入“主体批量替换”。在浏览器网络面板确认配置接口返回 HTTP 200、JSON 对象和 `models` 数组，再创建小批次验证上传、生成、预览与入库流程。

若页面显示“接口未返回有效 JSON 对象”，应检查构建时的 API 地址、Nginx 当前实际加载的 HTTPS 站点以及后端服务状态。新的错误提示可以定位异常，但仍需要恢复正确的接口链路才能使用批量替换。

修改管理密钥后，需使用 `--update-env` 重新加载两个 API 服务，否则进程仍使用旧值。

## 验证与构建问题

在本 README 所在目录执行：

```bash
node --test tests/api-response.test.mjs
npm run build
git diff --check
```

当前回归测试直接导入 TypeScript 文件，需使用支持直接运行 TypeScript 的 Node.js 版本，例如 Node.js 22.18 及以上版本。生产发布脚本本身要求 Node.js 20 及以上版本。

本次修复验证中，7 项响应回归检查通过，单独执行 `vite build` 打包通过；完整 `npm run build` 曾因本地依赖缺少 `@vue/language-core/lib/codegen/names` 而失败。遇到此类依赖缺失，先运行 `npm ci` 按锁文件重新安装，再执行完整构建。依赖安装失败时应先处理网络或安装错误，不应跳过类型检查发布。

### 多素材模板与 Excel 批量导入

页面最顶部提供“下载 Excel 示例”和“导入 Excel”入口。也可点击“＋ 新增模板”，填写模板名称，再为该模板手动添加多张图片、多个视频。可选择本地文件，或每行粘贴一个 HTTP(S) 原素材链接；无扩展名的链接需要指定图片或视频类型，再点击“添加链接”。

每个模板可以配置主体图片，默认应用于全部素材，也支持为某条素材单独设置主体或选择“保留原素材”。有主体的每张图片、每个视频分别调用对应替换模型；无主体素材保留原样。模型结果由 Worker 转存阿里云 OSS 后进入候选区，本地原素材在导入时上传 OSS，无主体的原素材外链则保留原链接。

候选区按模板展示全部图片和视频，每条素材独立显示状态、预览和重试入口。模板全部素材处理就绪后才能整组勾选入库。任意一条失败、处理中或版本过期时，后端拒绝整组入库，避免丢失部分素材。一次事务创建一个草稿模板，并将全部结果和原素材引用写入该模板的默认内容配置；重复提交不会创建多个模板。含视频的模板采用视频模型作为正式模板生成配置，仅含图片的模板采用图片模型；素材替换仍逐条按图片或视频类型路由。

Excel 支持多个工作表（跳过“说明”“填写说明”），首行列名如下：

| 列名 | 填写方式 |
| --- | --- |
| 模板标识 | 相同标识的行合并成一个模板，模板名称必须一致；留空时每行独立成模板 |
| 模板名称 | 建议填写；留空时使用模板标识或工作表名和行号 |
| 图片1、图片2、视频1、视频2等 | 可继续增加编号列，每格填写链接或锚定内嵌媒体；一个单元格可用换行填写多个链接 |
| 原素材 | 兼容旧表格，可替代上述编号列，支持图片或视频链接、内嵌媒体 |
| 媒体类型 | 使用“原素材”列且视频链接无扩展名时，填写“视频” |
| 主体图片 | 可选，图片链接或单张内嵌图片，应用于本行所有素材；同模板首个非空主体也作为模板默认主体，其他留空行继承，导入后可逐条选择保留原素材 |
| 替换要求 | 可选，叠加到统一替换要求，应用于本行全部素材 |

同一模板有更多素材时，可继续添加编号列，或新增相同“模板标识”的行。相同单元格中的多个常规内嵌媒体也会逐个读取。编号列优先按链接扩展名识别媒体类型，无扩展名时按列名识别。跨工作表使用相同标识也会合并；不同模板请使用不同标识。

普通单元格链接、超链接和包含文字地址的 `HYPERLINK` 公式均可读取。XLSX 支持通过 drawing 关系引用的内嵌图片/视频；旧 XLS 仅支持链接。OLE 附件、在线图片公式及本地磁盘路径不受支持，请改为媒体链接或直接选择文件。链接须能被模型服务访问。Excel 文件上限 50MB，解压后上限 300MB，单批次素材总数以服务端配置为准；数量按图片和视频合计，不按模板数计算。

本次部署涉及前端、主体替换 API 和 Worker，公共模板写入服务也提取了可复用的数据映射：先发布后端并重启 `vilo-template`、`vilo-template-remix-api`、`vilo-template-remix-worker`，再构建部署前端。后端执行 `npm run prisma:generate`、`npm run typecheck`、`npm run build`；前端执行 `npm run build`，静态部署命令沿用上文。无需新增数据库迁移。模板内每条素材沿用独立任务记录，共享同一个模板草稿 slug；逐素材主体仍保存于现有 JSON 字段。历史单素材模板兼容原有流程。

验收至少覆盖：同模板多图片、多视频、模板主体应用于全部素材、逐条主体覆盖、文件和链接混合导入、Excel 多列及多行合并、单素材失败重试、OSS 替换结果、完整集合入库、部分提交拦截及重复入库。真实模型、数据库事务、队列和 OSS 全链路需在实际配置环境中验收。
