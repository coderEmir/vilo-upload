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

每条图片、视频独立配置一张可选主体图片，或选择“保留原素材”。有主体的每张图片、每个视频分别调用对应替换模型；无主体素材保留原样。模型结果由 Worker 转存阿里云 OSS 后进入候选区，本地原素材在导入时上传 OSS，无主体的原素材外链则保留原链接。

候选区按模板展示全部图片和视频，每条素材独立显示状态、预览和重试入口。模板全部素材处理就绪后才能整组勾选入库。任意一条失败、处理中或版本过期时，后端拒绝整组入库，避免丢失部分素材。一次事务创建一个草稿模板，并将全部结果和原素材引用写入该模板的默认内容配置；重复提交不会创建多个模板。正式入库时按模板类型选择图片或视频模型；素材替换仍逐条按图片或视频类型路由。

Excel 支持多个工作表（跳过“说明”“填写说明”），首行列名如下：

| 列名 | 填写方式 |
| --- | --- |
| 模板标识 | 相同标识的行合并成一个模板，模板名称必须一致；留空时每行独立成模板 |
| 模板名称 | 建议填写；留空时使用模板标识或工作表名和行号 |
| 原素材 | 每行一条图片或视频链接，或一条锚定内嵌媒体；多素材分多行填写 |
| 原素材 | 兼容旧表格，可替代上述编号列，支持图片或视频链接、内嵌媒体 |
| 媒体类型 | 使用“原素材”列且视频链接无扩展名时，填写“视频” |
| 主体图片 | 可选，图片链接或单张内嵌图片，仅绑定本行唯一原素材，留空则保留本行原素材 |
| 替换要求 | 可选，叠加到统一替换要求，应用于本行全部素材 |

同一模板有更多素材时，可继续添加编号列，或新增相同“模板标识”的行。相同单元格中的多个常规内嵌媒体也会逐个读取。编号列优先按链接扩展名识别媒体类型，无扩展名时按列名识别。跨工作表使用相同标识也会合并；不同模板请使用不同标识。

普通单元格链接、超链接和包含文字地址的 `HYPERLINK` 公式均可读取。XLSX 支持通过 drawing 关系引用的内嵌图片/视频；旧 XLS 仅支持链接。OLE 附件、在线图片公式及本地磁盘路径不受支持，请改为媒体链接或直接选择文件。链接须能被模型服务访问。Excel 文件上限 50MB，解压后上限 300MB，单批次素材总数以服务端配置为准；数量按图片和视频合计，不按模板数计算。

本次部署涉及前端、主体替换 API 和 Worker，公共模板写入服务也提取了可复用的数据映射：先发布后端并重启 `vilo-template`、`vilo-template-remix-api`、`vilo-template-remix-worker`，再构建部署前端。后端执行 `npm run prisma:generate`、`npm run typecheck`、`npm run build`；前端执行 `npm run build`，静态部署命令沿用上文。无需新增数据库迁移。模板内每条素材沿用独立任务记录，共享同一个模板草稿 slug；逐素材主体仍保存于现有 JSON 字段。历史单素材模板兼容原有流程。

验收至少覆盖：同模板多图片、多视频、逐素材一对一主体配置、空主体不继承、文件和链接混合导入、Excel 多行合并及单行多素材拦截、单素材失败重试、OSS 替换结果、完整集合入库、部分提交拦截及重复入库。真实模型、数据库事务、队列和 OSS 全链路需在实际配置环境中验收。


### 图片模板与视频模板

Tab 区分模板类型（图片模板 IMAGE_GENERATION / 视频模板 SHORT_VIDEO），不限制素材类型。两类模板都支持多张图片、多个视频、模板提示词以及逐素材替换要求。Excel 导入保留全部图片和视频，并支持“模板提示词”列；同一模板标识的提示词应保持一致。图片素材交给图片替换模型，视频素材交给视频替换模型，无主体则保留原素材，全部处理完成后整组入库。

每个模板可单选对应类型的可用模型；图片模板使用图片生成模型，视频模板使用视频生成模型。实际主体替换仍使用后端 OPENAI_IMAGE_MODEL / SEEDANCE_MODEL_ID。

批次导入和列表过滤使用可选 templateType；templateDraft.type 保存模板类型。服务端在正式入库时校验模板类型与模型类型，正式入库优先使用显式模板类型，不再由素材中是否含视频决定。历史批次按正式模板 modelCode 归类，旧草稿未声明 type 的入库行为保持兼容。

无需数据库迁移；同步部署前端和主体替换 API。鉴权、整组事务、幂等和缓存失效机制沿用原实现。

批次名称无需填写，点击“导入并处理模板”时自动使用当前毫秒时间戳作为名称并保存到数据库。

### 主体替换与正式模板入库分离

导入与主体替换阶段只创建候选批次、素材和替换任务，不创建正式模板，也不要求选择正式模型。每条图片或视频最多配置一个主体；取消模板级、批次级共享主体。Excel 每行填写一条原素材（链接或嵌入素材）和对应的主体图片，同一模板的多条素材用相同模板标识分多行填写。主体为空的素材保留原样，不继承其他行主体。

候选结果处理完成后，人工勾选整个模板，并为每个模板选择一个正式入库模型，再点击整组入库。上传接口的每条 items 记录须包含 modelCode、parameters（同模板保持一致），以及既有 itemId 和可选 attemptId。服务端检查模型启用状态、模板类型匹配、模型参数、全部素材完成状态、选中状态及版本，然后执行原子入库。

正式入库复用模板管理的 templateCreateSchema、validateTemplateEpisodes、templateCreateData：图片模板为 IMAGE_GENERATION，视频模板为 SHORT_VIDEO，均保持一个默认 episode，完整保存图片和视频的 mediaAssets、referenceAssets、promptTemplate，并通过 episode.defaultParams 存储模型及参数。生成结果先转存 OSS，人工入库后仍按模板管理的草稿/发布流程控制 App 展示；主体替换成功不会自动发布到 App。

部署需同步更新前端与主体替换 API，并重启主体替换 Worker；无新增环境变量和数据库迁移。历史批次主体兼容读取保留，新导入禁止共享主体。

手动导入按素材逐行填写，从左到右依次为「原图片（视频）上传」「原图片链接（视频链接）」「主体图片上传或图片链接」。每行原素材的文件与链接二选一，主体的文件与链接二选一，后填写的内容替换前者；主体留空则保留原素材。点击「＋ 新增素材行」可为同一模板继续添加素材，支持逐行移除；无扩展名原素材链接可手选图片或视频类型。

原素材文件与原素材链接任选其一即可提交。链接自动按 URL 路径后缀识别图片或视频，忽略大小写、查询参数与片段；有后缀时显示识别结果，无后缀时才需要手动选择类型。

API 管理密钥输入后自动缓存到当前浏览器 localStorage，刷新或重新打开页面会恢复；清空输入即删除缓存。验证失败或服务暂不可用不会清掉已输入的密钥，缓存本身不代表鉴权通过。

主体替换页面的「刷新替换 / 入库状态」按钮重新读取批次列表和当前批次详情，更新生成进度、失败信息及正式模板入库状态，显示更新时间；刷新过程不会重新提交生成或入库。模板管理顶部的「刷新模板状态」按钮更新模板列表。

### 独立封面、预览和生成入参

每个模板分为三个独立区域：「指定封面」（一张静态图或动态图）、「指定预览」（一个视频或 GIF/WebP 动图）、「普通生成素材」（可多条图片和视频）。封面与预览均为可选，分别支持文件或链接、各自的一张可选主体图片和替换要求，不依附某条普通素材、不继承普通素材主体。候选结果也分区展示，处理完成并人工筛选后才正式入库。

新导入的 items[] 带 assetRole：INPUT、COVER、PREVIEW；每个模板最多一个 COVER 和一个 PREVIEW，且至少有一条 INPUT。用途保存在 sourceAsset JSON，不改数据库表。三类素材均独立处理、独立重试，封面和预览也计入单批次素材上限。

正式入库严格映射现有模板结构：COVER 的最终结果写入 Template.coverUrl；PREVIEW 的最终结果写入默认 TemplateEpisode.mediaAssets；INPUT 的最终结果写入默认 TemplateEpisode.referenceAssets，模板生成提示词写入 promptTemplate。主体替换成功时引用转存 OSS 的结果，未配置主体则保留原素材。未指定封面或预览时对应字段为空，不再借用普通生成素材作展示内容。既有未标记用途的历史批次保留原映射。模板类型及所选正式模型仍按图片/视频模板校验，写入复用模板管理的结构转换、事务和缓存失效逻辑。

Excel 示例增加「指定封面」「封面主体图片」「指定预览」「预览主体图片」列，支持 HTTP(S) 链接或内嵌素材；同模板只在一行配置封面和预览，其他行留空。重复配置或静态图片作为预览会报错（WebP 的动画属性需实际解码确认）。

动态图带主体时由 Worker 使用 FFmpeg 拆帧，逐帧调用图片编辑接口后合成为 GIF，再上传 OSS；不使用单张静态生成结果冒充动态预览。当前采样 8 帧/秒、最长 15 秒、最多 120 次图片编辑调用、输出长边不超过 1024 像素；无主体时保留原动图。静态 WebP 也经此解码流程，输出 GIF。部署 Worker 的系统须安装 FFmpeg 并加入 PATH（需支持 GIF/WebP 解码及 GIF 编码）；本地尚未安装，未验证实际动图转码及供应商调用。失败会保留失败状态，不会静默退化为静态图或入库。

部署需同步构建前端与后端，重启主体替换 API 和 Worker；无新增环境变量，无数据库迁移。模型/OSS/队列与 App 的真实全链路需在配置环境验收。
