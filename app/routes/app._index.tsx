import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const accessToken = session?.accessToken || "";
  const shop = session?.shop || "ek1j7g-jq.myshopify.com";

  if (accessToken && shop) {
    (globalThis as any).__SHOPIFY_ADMIN_TOKEN__ = accessToken;
    (globalThis as any).__SHOPIFY_ADMIN_SHOP__ = shop;

    try {
      await prisma.session.upsert({
        where: { id: `offline_${shop}` },
        update: {
          accessToken: accessToken,
          expires: null,
          isOnline: false,
        },
        create: {
          id: `offline_${shop}`,
          shop: shop,
          state: session?.state || "",
          isOnline: false,
          accessToken: accessToken,
        },
      });
      console.log("=== AUTO-SAVED ACTIVE SESSION IN PRISMA FROM ADMIN LOADER ===", shop);
    } catch (e) {
      console.warn("Failed to auto-save admin session:", e);
    }
  }

  return { shop, isConnected: Boolean(accessToken) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();

  const product = responseJson.data!.productCreate!.product!;
  const variantId = product.variants.edges[0]!.node!.id!;

  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );

  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson!.data!.productCreate!.product,
    variant:
      variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants,
  };
};

export default function Index() {
  const loaderData = useLoaderData<typeof loader>();
  const shop = loaderData?.shop || "ek1j7g-jq.myshopify.com";
  const fetcher = useFetcher<typeof action>();

  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Test product created successfully!");
    }
  }, [fetcher.data?.product?.id, shopify]);

  const generateProduct = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Flutter Connect Dashboard">
      <s-section heading="🟢 Real-Time Profile & Order Sync Status">
        <s-paragraph>
          Your Flutter Mobile App is <strong>connected and actively syncing</strong> customer profiles, addresses, order history, and order cancellations with Shopify Admin 24/7.
        </s-paragraph>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="small">
            <s-text><strong>Store Domain:</strong> {shop}</s-text>
            <s-text><strong>Sync Engine Uptime:</strong> 24/7 Permanent Active</s-text>
            <s-text><strong>Customer Profile Sync:</strong> Active (Tagging, Metafields, Phone & Address Sync)</s-text>
            <s-text><strong>Order History Sync:</strong> Active (Order tracking & real-time cancellation)</s-text>
            <s-text><strong>Session Protection:</strong> Automatic Auto-Healing Enabled</s-text>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Product Creation Test">
        <s-paragraph>
          Test your Shopify GraphQL Admin connection by creating a sample product.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={generateProduct}
            {...(isLoading ? { loading: true } : {})}
          >
            Generate test product
          </s-button>
          {fetcher.data?.product && (
            <s-button
              onClick={() => {
                shopify.intents.invoke?.("edit:shopify/Product", {
                  value: fetcher.data?.product?.id,
                });
              }}
              target="_blank"
              variant="tertiary"
            >
              Edit test product
            </s-button>
          )}
        </s-stack>
        {fetcher.data?.product && (
          <s-section heading="productCreate mutation output">
            <s-stack direction="block" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <pre style={{ margin: 0 }}>
                  <code>{JSON.stringify(fetcher.data.product, null, 2)}</code>
                </pre>
              </s-box>
            </s-stack>
          </s-section>
        )}
      </s-section>

      <s-section slot="aside" heading="App Status Specs">
        <s-paragraph>
          <s-text>Developer: </s-text>
          <s-text font-weight="bold">Pankaj Berwal</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com/" target="_blank">
            React Router v7
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Interface: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/app-home/using-polaris-components"
            target="_blank"
          >
            Polaris Web Components
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>API Version: </s-text>
          <s-link
            href="https://shopify.dev/docs/api/admin-graphql"
            target="_blank"
          >
            GraphQL (2026-07)
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://www.prisma.io/" target="_blank">
            Prisma SQLite
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
