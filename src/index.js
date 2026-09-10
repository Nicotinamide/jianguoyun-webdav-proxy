/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 优化版：防 520 错误、请求头清洗、根路径健康检测、支持 HTTPS->HTTP 自动回退
 */

export default {
  async fetch(request, env, ctx) {
    const TARGET_HOST = env.TARGET_HOST || "dav.jianguoyun.com";
    const TARGET_PROTOCOL = env.TARGET_PROTOCOL || "https";
    const clientUrl = new URL(request.url);

    // 1. 如果在浏览器中直接访问根路径 "/"，返回友好的状态页面，避免坚果云直接拒连报错
    if (clientUrl.pathname === "/" || clientUrl.pathname === "") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>坚果云 WebDAV 代理状态</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; line-height: 1.6; max-width: 680px; margin: auto;">
  <h2>✅ 坚果云 WebDAV 代理 Worker 运行正常</h2>
  <p>WebDAV 服务端点路径为：<code>${clientUrl.origin}/dav/</code></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <h3>客户端配置指南</h3>
  <ul>
    <li><strong>服务器地址 (URL)</strong>: <code>${clientUrl.origin}/dav/</code></li>
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

    // 2. 构造目标 URL
    const targetUrl = new URL(request.url);
    targetUrl.hostname = TARGET_HOST;
    targetUrl.protocol = `${TARGET_PROTOCOL}:`;
    targetUrl.port = TARGET_PROTOCOL === "http" ? "80" : "443";

    // 3. 清洗并重写请求头，过滤掉容易触发源站防火墙/WAF 的代理专有头
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
    if (newHeaders.has("Origin")) {
      newHeaders.set("Origin", `${TARGET_PROTOCOL}://${TARGET_HOST}`);
    }

    // 4. 重写 WebDAV 的 Destination 头（MOVE/COPY 文件时必需）
    const destination = newHeaders.get("Destination");
    if (destination) {
      try {
        const destUrl = new URL(destination);
        destUrl.hostname = TARGET_HOST;
        destUrl.protocol = `${TARGET_PROTOCOL}:`;
        destUrl.port = TARGET_PROTOCOL === "http" ? "80" : "443";
        newHeaders.set("Destination", destUrl.toString());
      } catch (_) {}
    }

    // 5. 构造请求
    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });

    try {
      let response = await fetch(newRequest);

      // 6. 核心防 520 处理：若 HTTPS 连接出现 520 异常，自动降级尝试 HTTP
      if (response.status === 520 && TARGET_PROTOCOL === "https") {
        const fallbackUrl = new URL(targetUrl.toString());
        fallbackUrl.protocol = "http:";
        fallbackUrl.port = "80";

        const fallbackHeaders = new Headers(newHeaders);
        fallbackHeaders.set("Host", TARGET_HOST);
        if (fallbackHeaders.has("Origin")) {
          fallbackHeaders.set("Origin", `http://${TARGET_HOST}`);
        }

        const fallbackReq = new Request(fallbackUrl.toString(), {
          method: request.method,
          headers: fallbackHeaders,
          body: hasBody ? request.body : null,
          redirect: "manual",
        });

        response = await fetch(fallbackReq);
      }

      // 7. 处理返回头（改写 Location 重定向域名）
      const respHeaders = new Headers(response.headers);
      const location = respHeaders.get("Location");
      if (location) {
        try {
          const locUrl = new URL(location);
          if (locUrl.hostname === TARGET_HOST) {
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
