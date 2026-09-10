/**
 * Cloudflare Worker 反向代理坚果云 WebDAV
 * 支持 WebDAV 所有标准请求方法及 Header 重写 (特别是 Destination)
 */

export default {
  async fetch(request, env, ctx) {
    // 目标 WebDAV 服务器地址（支持通过环境变量 TARGET_HOST 自定义）
    const TARGET_HOST = env.TARGET_HOST || "dav.jianguoyun.com";
    const clientUrl = new URL(request.url);

    // 1. 构造目标 URL
    const targetUrl = new URL(request.url);
    targetUrl.hostname = TARGET_HOST;
    targetUrl.protocol = "https:";
    targetUrl.port = "";

    // 2. 复制并重写请求头
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", TARGET_HOST);
    if (newHeaders.has("Origin")) {
      newHeaders.set("Origin", `https://${TARGET_HOST}`);
    }

    // 3. 关键处理：WebDAV 的 MOVE / COPY 方法依赖 Destination 请求头
    const destination = newHeaders.get("Destination");
    if (destination) {
      try {
        const destUrl = new URL(destination);
        destUrl.hostname = TARGET_HOST;
        destUrl.protocol = "https:";
        destUrl.port = "";
        newHeaders.set("Destination", destUrl.toString());
      } catch (e) {
        // 忽略无法解析的 Destination
      }
    }

    // 4. GET / HEAD 请求不能带有 request.body
    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());

    const newRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });

    try {
      // 5. 向坚果云发起请求
      const response = await fetch(newRequest);

      // 6. 处理返回头（若包含 Location 重定向，将其改写回反代域名）
      const respHeaders = new Headers(response.headers);
      const location = respHeaders.get("Location");
      if (location) {
        try {
          const locUrl = new URL(location, targetUrl);
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
