/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 核心目标域名：dav.jianguoyun.com
 * 关键点：
 * 1. 根路径 "/" 拦截并返回健康检测页面，防止直接请求根路径报 520
 * 2. 清洗所有 cf-*、cdn-loop、x-forwarded-* 等标头，防止被源站 CDN 回环阻断
 * 3. 规范 Destination 头与 Location 重定向
 */

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

    // 3. 构造请求目标 URL (完整使用 https://dav.jianguoyun.com)
    const targetUrl = new URL(request.url);
    targetUrl.protocol = "https:";
    targetUrl.hostname = TARGET_HOST;
    targetUrl.port = "";
    targetUrl.pathname = pathname;

    // 4. 清洗请求头：必须剔除 cf-*、cdn-loop 等，避免 Cloudflare 内部判定环路
    const newHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("cf-") ||
        lower === "cdn-loop" ||
        lower.startsWith("x-forwarded") ||
        lower === "x-real-ip" ||
        lower === "host"
      ) {
        continue;
      }
      newHeaders.set(key, value);
    }

    // 5. 重写 WebDAV 的 Destination 头（MOVE/COPY 重命名文件时必需）
    const destination = newHeaders.get("Destination");
    if (destination) {
      try {
        const destUrl = new URL(destination);
        destUrl.protocol = "https:";
        destUrl.hostname = TARGET_HOST;
        destUrl.port = "";
        newHeaders.set("Destination", destUrl.toString());
      } catch (_) {}
    }

    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: "follow",
    });

    try {
      const response = await fetch(newRequest);

      // 6. 处理返回头，改写 Location 重定向（若有）
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
