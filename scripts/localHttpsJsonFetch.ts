import { request } from "node:https";

import type { RemoteOAuthDiscoveryFetch } from "./smokeRemoteOAuthHttpCore.js";

export const fetchLocalHttpsJsonWithoutCertificateVerification: RemoteOAuthDiscoveryFetch =
  async (url) =>
    await new Promise((resolve, reject) => {
      const requestHandle = request(
        url,
        {
          headers: {
            accept: "application/json",
          },
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(body) as unknown,
            });
          });
        },
      );

      requestHandle.on("error", reject);
      requestHandle.end();
    });
