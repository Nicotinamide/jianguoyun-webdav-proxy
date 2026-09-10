/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 终极防 520 方案：
 * 1. 坚果云海外域名被解析到了 Cloudflare 自身的节点 (cloudflarelb.jianguoyun.com)，导致 Worker 触发 CDN 环路报错 520。
 * 2. 本脚本直接将回源目标锁定为坚果云国内真实源站机房 IP (58.215.175.52 / 58.215.175.53)，并走 HTTP 80 (带 Host: dav.jianguoyun.com 头)，
 *    彻底绕过海外 CDN-Loop、SSL 证书握手异常与 WAF 阻断。
 */

// 坚果云国内真实电信源站机房 IP
const NUTSTORE_ORIGIN_IPS = ["58.215.175.52", "58.215.175.53"];
const TARGET_HOST = "dav.jianguoyun.com";

export default {
  async fetch(request, env, ctx) {
    const clientUrl = new URL(request.url);

    // 1. 如果在浏览器中直接访问根路径 "/"，返回友好的状态页面
    if (clientUrl.pathname === "/" || clientUrl.pathname === "") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>坚果云 WebDAV 代理状态</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; line-height: 1.6; max-width: 680px; margin: auto;">
  <h2>✅ 坚果云 WebDAV 代理 Worker 运行正常</h2>
  <p>WebDAV 服务端点路径为：<code>${clientUrl.origin}/dav/</code></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <h3>Obsidian / Remotely Save 配置指南</h3>
  <ul>
    <li><strong>服务器地址 (URL)</strong>: <code>${clientUrl.origin}/dav/</code> (结尾务必带上 <code>/dav/</code>)</li>
    <li><strong>用户名</strong>: 坚果云注册邮箱</li>
    <li><strong>密码</strong>: 坚果云后台生成的第三方应用专用密码（非网页登录密码）</li>
  </ul>
</body>
</html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    // 2. 自动补全 /dav 缺少结尾斜杠的情况
    let pathname = clientUrl.pathname;
    if (pathname === "/dav") {
      pathname = "/dav/";
    }

    // 3. 清洗请求头（彻底过滤 Cloudflare 特征头，保留标准 WebDAV 和 Basic Auth 鉴权头）
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

    // 4. 重写 WebDAV 的 Destination 头（重命名/移动文件时必需）
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

    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());

    // 5. 核心：直接回源到坚果云真实机房 IP，避免解析到海外 Cloudflare 假节点造成 520
    const originHost = env.TARGET_ORIGIN || NUTSTORE_ORIGIN_IPS[0];
    const targetUrl = new URL(request.url);
    targetUrl.hostname = originHost;
    targetUrl.pathname = pathname;
    targetUrl.protocol = "http:";
    targetUrl.port = "80";

    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });

    try {
      let response = await fetch(newRequest);

      // 如果当前 IP 偶发异常，轮询尝试备用源站 IP
      if (response.status >= 500 && NUTSTORE_ORIGIN_IPS.length > 1) {
        const backupHost = NUTSTORE_ORIGIN_IPS[1];
        const backupUrl = new URL(targetUrl.toString());
        backupUrl.hostname = backupHost;
        const backupReq = new Request(backupUrl.toString(), {
          method: request.method,
          headers: newHeaders,
          body: hasBody ? request.body : null,
          redirect: "manual",
        });
        response = await fetch(backupReq);
      }

      // 6. 处理返回头（若包含 Location 重定向，将其改写为客户端访问的域名）
      const respHeaders = new Headers(response.headers);
      const location = respHeaders.get("Location");
      if (location) {
        try {
          const locUrl = new URL(location);
          if (locUrl.hostname === TARGET_HOST || NUTSTORE_ORIGIN_IPS.includes(locUrl.hostname)) {
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
