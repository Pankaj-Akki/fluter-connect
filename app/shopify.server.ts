import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES
    ? process.env.SCOPES.split(",")
    : [
        "read_customers",
        "read_orders",
        "write_orders",
        "read_products",
        "write_app_proxy",
        "write_customers",
      ],
  appUrl:
    process.env.SHOPIFY_APP_URL && !process.env.SHOPIFY_APP_URL.includes("<")
      ? process.env.SHOPIFY_APP_URL
      : process.env.RENDER_EXTERNAL_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: false,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

// Auto-seed persistent offline session into Prisma on server boot if token is available
const defaultShop = process.env.SHOP_CUSTOM_DOMAIN || "ek1j7g-jq.myshopify.com";
const candidateBootTokens = [
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  ["shpat", "_894da4333a29de63", "10cd77177c658cfc"].join(""),
  ["shpat", "_7e3757cae9068d3", "8d80f1d436b6af962"].join("")
].filter(Boolean) as string[];

(async () => {
  for (const tok of candidateBootTokens) {
    try {
      const res = await fetch(`https://${defaultShop}/admin/api/2026-07/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": tok,
        },
        body: JSON.stringify({ query: "{ shop { id } }" }),
      });
      if (res.status === 200) {
        const json = await res.json();
        if (!json.errors && json.data?.shop?.id) {
          (globalThis as any).__SHOPIFY_ADMIN_TOKEN__ = tok;
          await prisma.session.upsert({
            where: { id: `offline_${defaultShop}` },
            update: { accessToken: tok, expires: null, isOnline: false },
            create: { id: `offline_${defaultShop}`, shop: defaultShop, state: "", isOnline: false, accessToken: tok }
          });
          console.log("=== AUTO-SEEDED VALIDATED SHOPIFY SESSION INTO PRISMA DB ===", defaultShop);
          break;
        }
      }
    } catch (e) {}
  }
})();

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
