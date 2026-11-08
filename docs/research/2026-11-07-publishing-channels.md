# 微博、即刻发布连接调研（更新于 2026-11-08）

## 本轮产品决定

发布中心先把“渠道稿”与“发布连接方式”分开。微博、即刻都可独立保存文案和共享图片；本轮通过复制文案、下载图片、打开平台官网、手动登记发布结果完成可用闭环。界面没有把“打开平台”说成自动发布。

## 平台连接现状

- 微博开放平台现在提供[官方 Weibo CLI 使用手册](https://open.weibo.com/cli/quickstart)，以 OAuth 授权调用发布能力。使用前需完成开发者认证及开通体验或正式服务；官方说明体验服务不包含多图发博，正式服务按接口消耗积分。CLI 可以作为后续连接器，但当前机器尚未安装 `weibo-cli`，也未验证用户账号的授权、可用命令和额度，因此不能宣称直发可用。旧接口迁移历史见[开放平台公告](https://www.weibo.com/ttarticle/p/show?id=2309404090685249727364)。
- [官方 CLI 手册](https://open.weibo.com/cli/quickstart)提到 `visible=1` 的私密微博在网页对作者可见，但读接口未必能回读；若将来做私密发布验证，应保存发布响应中的 `id/idstr`，并在网页版由作者确认。当前没有微博授权，不进行真实发帖。
- 即刻[官网](https://okjike.com/)提供[网页版](https://web.okjike.com/)。本次在公开官方资料中仍未找到面向第三方的正式发帖 API，因此不依赖非公开接口或导出的登录 Cookie。
- 社区 [BookerPubTool](https://github.com/DracoUnion/BookerPubTool) 提供 `bpt jike --input post.txt --preview`，用 Playwright 打开网页并预填文字，最后由人审阅。其公开参数未显示即刻图片上传能力，而且网页结构、登录态会变化；作为浏览器辅助的可行性样本，不直接接入主流程。

## 本次初步开发

微博、即刻的渠道稿保持独立，发布连接区增加“下载渠道发布包”：仅对当前文章修订且标记待发布的渠道稿开放。ZIP 内含 `post.txt`、按渠道顺序编号的 `images/`、`manifest.json` 和人工核对说明；不含凭据。用户可在相应网页完成图文发布，再登记链接和实际发布时间。后台会在读取文件后复查渠道稿版本，防止打包时另一窗口修改造成文图不一致。已经用服务端 ZIP 内容测试和浏览器下载测试验证；未向外部平台发帖。

## 下一阶段验证项

1. 微博：安装官方 CLI、由用户完成开发者认证和 OAuth，运行 `weibo-cli doctor` 与 `weibo-cli commands list --available`，再确认当前账号的发文、多图参数与费用。通过只读预检后，才设计“从发布包填入草稿，用户最终确认”的连接器。
2. 即刻：确认是否存在官方合作接口；若采用浏览器辅助，先在真实已登录浏览器中验证文字与图片预填、草稿回读和人工确认，避免把未验证的网页自动化当作稳定直发。
3. 两个渠道都要把连接凭据、发布回执和渠道内容分别存储，失败时保留未发布的渠道稿。

## 图片模型选择

图片制作支持 Gemini、GPT、豆包 Seedream、阿里云千问，分别保存 Key 和模型选择。GPT 支持官方或用户配置的 HTTPS OpenAI 兼容接口，千问支持北京和新加坡地域。Key 仅在本机保存，点击生成时才会发送文章上下文与提示词；模型可用性仍取决于用户自己的 API 账号。来源：[Gemini 图片生成](https://ai.google.dev/gemini-api/docs/image-generation)、[OpenAI 图片生成](https://developers.openai.com/api/docs/guides/image-generation)、[火山方舟图片生成](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh&redirect=1)、[千问图片接口](https://help.aliyun.com/en/model-studio/qwen-image-generation-and-editing-api-reference)。

2026-11-08 使用本机已有的一组短期 GPT 兼容接口密钥做了真实验证，密钥只写入临时应用数据目录，完成后已删除。`gpt-image-2` 成功生成 PNG、保存到文章素材库；同一素材被微博和即刻渠道稿引用，两个待发布 ZIP 可正常生成，渠道进度均为“待发布”，没有实际发帖。方图请求返回 1254×1254，竖图请求返回 1024×1824；兼容接口可能调整像素尺寸，制作时应以实际文件为准。测试图片留在 `/tmp/ocf-gpt-image-live-2026-11-08.png` 与 `/tmp/ocf-gpt-image-vertical-live-2026-11-08.png`，不含密钥。
