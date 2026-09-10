/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 完美解决方案：
 * 1. 避免 520 错误：不请求海外解析出的 Cloudflare Anycast 假节点 (cloudflarelb.jianguoyun.com)。
 * 2. 避免 1003 错误：不直接 fetch 裸 IP（Cloudflare Workers 禁止直接请求裸 IP）。
 * 3. 核心机制：回源使用坚果云国内直连域名 (appct.jianguoyun.com / appcu.jianguoyun.com)，
 *    带上 Host: dav.jianguoyun.com，直接穿透到国内源站机房！
 */

// 坚果云国内电信/联通直连域名（均为有效域名，非裸 IP，且均不经过海外 Cloudflare CDN）
const BACKEND_HOSTS = ["appct.jianguoyun.com", "appcu.jianguoyun.com"];
const TARGET_HOST = "dav.jianguoyun.com";

export default {
  async fetch(request, env, ctx) {
    const clientUrl = new URL(request.url);

    // 1. 如果在浏览器直接访问根路径 "/"，返回友好的状态页面
    if (clientUrl.pathname === "/" || clientUrl.pathname === "") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>坚果云 WebDAV 代理状态</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; line-height: 1.6; max-width: 680px; margin: auto;">
  <h2>✅ 坚果云 WebDAV 代理已正常运行</h2>
  <p>当前绑定的自定义域名：<code>${clientUrl.origin}</code></p>
  <p>WebDAV 服务端点路径为：<code>${clientUrl.origin}/dav/</code></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <h3>Obsidian / Remotely Save / Zotero 配置提示</h3>
  <ul>
    <li><strong>服务器地址 (URL)</strong>: <code>${clientUrl.origin}/dav/</code> (结尾务必带上 <code>/dav/</code>)</li>
    <li><strong>用户名</strong>: 坚果云注册邮箱</li>
    <li><strong>密码</strong>: 坚果云后台生成的应用专用密码（非网页登录密码）</li>
  </ul>
</body>
</html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    // 2. 自动修正 /dav 缺少结尾斜杠的问题
    let pathname = clientUrl.pathname;
    if (pathname === "/dav") {
      pathname = "/dav/";
    }

    // 3. 清洗并重写请求头，过滤 Cloudflare 专有头
    const newHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("cf-") ||
        lower === "cdn-loop" ||
        lower.startsWith("x-forwarded") ||
        lower === "x-real-ip"
      ) {
        continue;
      }
      newHeaders.set(key, value);
    }

    newHeaders.set("Host", TARGET_HOST);
    newHeaders.set("Origin", `http://${TARGET_HOST}`);

    // 4. 重写 WebDAV 的 Destination 头（重命名/移动文件时必须匹配 Host）
    const destination = newHeaders.get("Destination");
    if (destination) {
      try {
        const destUrl = new URL(destination);
        destUrl.hostname = TARGET_HOST;
        destUrl.protocol = "http:";
        destUrl.port = "80";
        newHeaders.set("Destination", destUrl.toString());
      } catch (_) {}
    }

    // 5. 回源请求：使用 appct.jianguoyun.com / appcu.jianguoyun.com，带 Host: dav.jianguoyun.com
    const backendHost = env.BACKEND_HOST || BACKEND_HOSTS[0];
    const targetUrl = new URL(request.url);
    targetUrl.hostname = backendHost;
    targetUrl.pathname = pathname;
    targetUrl.protocol = "http:";
    targetUrl.port = "80";

    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });

    try {
      let response = await fetch(newRequest);

      // 如果首选后端异常，自动切换备用后端重试
      if (response.status >= 500 && BACKEND_HOSTS.length > 1) {
        const fallbackUrl = new URL(targetUrl.toString());
        fallbackUrl.hostname = BACKEND_HOSTS[1];
        const fallbackReq = new Request(fallbackUrl.toString(), {
          method: request.method,
          headers: newHeaders,
          body: hasBody ? request.body : null,
          redirect: "manual",
        });
        response = await fetch(fallbackReq);
      }

      // 6. 处理返回头，改写 Location 重定向（防止客户端跳回到坚果云后端域名）
      const respHeaders = new Headers(response.headers);
      const location = respHeaders.get("Location");
      if (location) {
        try {
          const locUrl = new URL(location);
          if (
            locUrl.hostname === TARGET_HOST ||
            BACKEND_HOSTS.includes(locUrl.hostname)
          ) {
            locUrl.hostname = clientUrl.hostname;
            locUrl.protocol = clientUrl.protocol;
            locUrl.port = clientUrl.port;
            respHeaders.set("Location", locUrl.toString());
          }
        } catch (_) {}
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Proxy to Jianguoyun failed",
          message: err.message,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
};
