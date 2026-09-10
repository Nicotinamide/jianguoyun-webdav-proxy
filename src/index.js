/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 终极黑科技：使用 cloudflare:sockets 直连 TCP 端口 80
 * 优势：
 * 1. 彻底绕过 Cloudflare 免费版对 Host 头的限制（无需昂贵 Enterprise 套餐）
 * 2. 彻底杜绝 520 跨 Zone 限制错误（不走 fetch Anycast 节点）
 * 3. 彻底杜绝 1003 裸 IP 访问限制（TCP socket 允许任意 IP 与端口）
 * 4. 彻底杜绝 301 重定向循环（直接在 TCP 报文中写入 Host: dav.jianguoyun.com）
 */

import { connect } from "cloudflare:sockets";

const ORIGIN_IP = "58.215.175.52";
const ORIGIN_PORT = 80;
const TARGET_HOST = "dav.jianguoyun.com";

export default {
  async fetch(request, env, ctx) {
    const clientUrl = new URL(request.url);

    // 1. 根路径 "/" 拦截并返回健康检测页面
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

    let pathname = clientUrl.pathname;
    if (pathname === "/dav") {
      pathname = "/dav/";
    }

    try {
      // 2. 通过 cloudflare:sockets 建立与坚果云电信机房的原生 TCP 连接
      const socket = connect({
        hostname: ORIGIN_IP,
        port: ORIGIN_PORT,
      });

      const writer = socket.writable.getWriter();
      const encoder = new TextEncoder();

      // 3. 构建标准原生 HTTP 报文
      const pathWithQuery = pathname + clientUrl.search;
      let headerText = `${request.method} ${pathWithQuery} HTTP/1.1\r\n`;
      headerText += `Host: ${TARGET_HOST}\r\n`;
      headerText += `Connection: close\r\n`;

      for (const [key, value] of request.headers.entries()) {
        const lower = key.toLowerCase();
        if (
          lower === "host" ||
          lower === "connection" ||
          lower.startsWith("cf-") ||
          lower === "cdn-loop" ||
          lower.startsWith("x-forwarded") ||
          lower === "x-real-ip"
        ) {
          continue;
        }

        // WebDAV MOVE / COPY 的 Destination 标头重写
        if (lower === "destination") {
          try {
            const destUrl = new URL(value);
            destUrl.hostname = TARGET_HOST;
            destUrl.protocol = "http:";
            destUrl.port = "80";
            headerText += `Destination: ${destUrl.toString()}\r\n`;
            continue;
          } catch (_) {}
        }

        headerText += `${key}: ${value}\r\n`;
      }
      headerText += `\r\n`;

      // 写入请求头
      await writer.write(encoder.encode(headerText));

      // 写入请求体（PUT 上传文件、POST、PROPPATCH 等）
      if (
        request.body &&
        !["GET", "HEAD"].includes(request.method.toUpperCase())
      ) {
        const reader = request.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }

      // 4. 解析来自坚果云的响应
      const socketReader = socket.readable.getReader();
      let buffer = new Uint8Array(0);
      let headerEndIndex = -1;

      function concat(a, b) {
        const c = new Uint8Array(a.length + b.length);
        c.set(a, 0);
        c.set(b, a.length);
        return c;
      }

      // 持续读取直到捕获完整的 HTTP 标头结尾 (\r\n\r\n)
      while (headerEndIndex === -1) {
        const { done, value } = await socketReader.read();
        if (done) break;
        buffer = concat(buffer, value);

        for (let i = 0; i <= buffer.length - 4; i++) {
          if (
            buffer[i] === 13 &&
            buffer[i + 1] === 10 &&
            buffer[i + 2] === 13 &&
            buffer[i + 3] === 10
          ) {
            headerEndIndex = i;
            break;
          }
        }
      }

      if (headerEndIndex === -1) {
        return new Response("Invalid response from origin", { status: 502 });
      }

      const decoder = new TextDecoder();
      const rawHeaderStr = decoder.decode(buffer.slice(0, headerEndIndex));
      const remainingBody = buffer.slice(headerEndIndex + 4);

      // 解析状态码
      const headerLines = rawHeaderStr.split("\r\n");
      const statusLine = headerLines[0]; // 例如 "HTTP/1.1 207 Multi-Status"
      const statusParts = statusLine.split(" ");
      const statusCode = parseInt(statusParts[1], 10) || 200;
      const statusText = statusParts.slice(2).join(" ");

      // 解析并改写返回标头
      const responseHeaders = new Headers();
      for (let i = 1; i < headerLines.length; i++) {
        const line = headerLines[i];
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let val = line.slice(colonIdx + 1).trim();

          if (key.toLowerCase() === "location") {
            try {
              const locUrl = new URL(val);
              if (
                locUrl.hostname === TARGET_HOST ||
                locUrl.hostname === ORIGIN_IP
              ) {
                locUrl.hostname = clientUrl.hostname;
                locUrl.protocol = clientUrl.protocol;
                locUrl.port = clientUrl.port;
                val = locUrl.toString();
              }
            } catch (_) {}
          }

          if (["connection", "transfer-encoding"].includes(key.toLowerCase())) {
            continue;
          }

          responseHeaders.append(key, val);
        }
      }

      // 5. 将剩余及后续数据流无缝返回给客户端
      const bodyStream = new ReadableStream({
        async start(controller) {
          if (remainingBody.length > 0) {
            controller.enqueue(remainingBody);
          }
          try {
            while (true) {
              const { done, value } = await socketReader.read();
              if (done) {
                controller.close();
                break;
              }
              controller.enqueue(value);
            }
          } catch (e) {
            controller.error(e);
          }
        },
      });

      return new Response(bodyStream, {
        status: statusCode,
        statusText: statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Socket Proxy Error",
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
