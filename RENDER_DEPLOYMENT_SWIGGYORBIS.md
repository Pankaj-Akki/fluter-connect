# Render Deployment Guide for Store: `swiggyorbis.myshopify.com`

This guide explains how to deploy `fluter-connect` to the Render project **`Orbis-Swiggy-06`** (`https://dashboard.render.com/project/prj-db2cplks728c73c02b10`) for the store `swiggyorbis.myshopify.com` while keeping your old store deployment completely preserved.

---

## 🔒 Multi-Store Architecture Strategy

To ensure your existing store connection (`ek1j7g-jq.myshopify.com` / `fluter-connect.onrender.com`) is **never affected or overwritten**:

1. **Old Store**: Uses `shopify.app.toml` and existing Render service (`fluter-connect.onrender.com`).
2. **New Store (`swiggyorbis`)**: Uses a dedicated Shopify App Client ID & `shopify.app.swiggyorbis.toml` and runs in the new Render project `Orbis-Swiggy-06`.

---

## 📋 Step-by-Step Deployment Instructions

### Step 1: Create a Dedicated Shopify App for `swiggyorbis`

1. Log into [Shopify Partner Dashboard](https://partners.shopify.com/) (using the same email).
2. Go to **Apps** -> **Create app** -> **Create app manually**.
3. App Name: `fluter-connect-swiggyorbis`.
4. Copy the newly generated **Client ID** and **Client Secret**.

---

### Step 2: Configure Render Web Service in Project `Orbis-Swiggy-06`

1. Go to your Render Project: [https://dashboard.render.com/project/prj-db2cplks728c73c02b10](https://dashboard.render.com/project/prj-db2cplks728c73c02b10)
2. Click **`+ Create new service`** -> Select **`Web Service`**.
3. Connect your GitHub repository (`Pankaj-Akki/fluter-connect`).
4. Set up the service settings:
   - **Name**: `orbis-swiggy-06` (or `swiggyorbis-connect`).
   - **Region**: Select your preferred region.
   - **Branch**: `main`
   - **Runtime**: `Docker` *(Render auto-detects `Dockerfile` in root)*.
   - **Instance Type**: Free / Starter.
5. In **Environment Variables**, add the following key-value pairs:

| Key | Value |
|---|---|
| `SHOPIFY_API_KEY` | *(Your SwiggyOrbis App Client ID from Step 1)* |
| `SHOPIFY_API_SECRET` | *(Your SwiggyOrbis App Client Secret from Step 1)* |
| `SHOPIFY_APP_URL` | `https://<your-service-name>.onrender.com` |
| `SCOPES` | `read_customers,read_orders,write_orders,read_products,write_app_proxy,write_customers` |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |

6. Click **Create Web Service** and wait for Docker build to complete.

---

### Step 3: Update `shopify.app.swiggyorbis.toml` & Deploy Configuration

1. Open `shopify.app.swiggyorbis.toml` in your editor.
2. Replace `client_id` and `application_url` with your new values:
   ```toml
   client_id = "YOUR_SWIGGYORBIS_SHOPIFY_CLIENT_ID"
   application_url = "https://<your-service-name>.onrender.com"

   [auth]
   redirect_urls = [ "https://<your-service-name>.onrender.com/auth/callback" ]
   ```
3. Deploy configuration to Shopify:
   ```bash
   npx shopify app deploy --config swiggyorbis
   ```

---

### Step 4: Install App on `swiggyorbis.myshopify.com`

1. In Shopify Partner Dashboard, select the `fluter-connect-swiggyorbis` app.
2. Go to **Test your app** -> Select store **`swiggyorbis.myshopify.com`**.
3. Click **Install app** to complete OAuth authorization.

---

### Step 5: Test Customer Sync Integration

Verify customer sync proxy on `swiggyorbis.myshopify.com`:
```text
https://swiggyorbis.myshopify.com/apps/flutter-sync/customer?customer_id=R458&name=Swiggy%20User&email=user@swiggyorbis.com&membership_level=VIP
```
Check Shopify Admin for `swiggyorbis` under **Customers** to verify the entry created.
