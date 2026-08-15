namespace Cloudflare {
  interface Env {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    COOKIE_ENCRYPTION_KEY: string;
    PUBLIC_URL: string;
    OAUTH_KV: KVNamespace;
    MCP_OBJECT: DurableObjectNamespace;
  }
}

type Env = Cloudflare.Env;
